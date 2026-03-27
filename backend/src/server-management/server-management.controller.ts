import { Controller, Get, Post, Body, Param, NotFoundException, Put, Query, BadRequestException, ValidationPipe, Delete, UseGuards, Request, UseInterceptors, UploadedFile, Logger } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DockerComposeService } from 'src/docker-compose/docker-compose.service';
import { ServerManagementService } from './server-management.service';
import { UpdateServerConfigDto } from './dto/server-config.model';
import { ServerListItemDto } from './dto/server-list-item.dto';
import { JwtAuthGuard } from 'src/auth/guards/auth.guard';
import { SettingsService } from 'src/users/services/settings.service';
import { PayloadToken } from 'src/auth/models/token.model';
import { ProxyService } from 'src/proxy/proxy.service';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs-extra';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { exec } from 'node:child_process';

const execAsync = promisify(exec);

@Controller('servers')
@UseGuards(JwtAuthGuard)
export class ServerManagementController {
  private readonly logger = new Logger(ServerManagementController.name);
  private readonly SERVERS_DIR: string;

  constructor(
    private readonly dockerComposeService: DockerComposeService,
    private readonly managementService: ServerManagementService,
    private readonly settingsService: SettingsService,
    private readonly proxyService: ProxyService,
    private readonly configService: ConfigService,
  ) {
    this.SERVERS_DIR = this.configService.get('serversDir');
  }

  @Get()
  async getAllServers(): Promise<ServerListItemDto[]> {
    const serverConfigs = await this.dockerComposeService.getAllServerConfigs();
    return ServerListItemDto.fromServerConfigs(serverConfigs);
  }

  @Get('all-status')
  async getAllServersStatus() {
    const allStatus = await this.managementService.getAllServersStatus();
    return allStatus;
  }

  @Get('all-resources')
  async getAllServersResources() {
    return this.managementService.getAllServersResources();
  }

  @Get(':id')
  async getServer(@Param('id') id: string) {
    const config = await this.dockerComposeService.getServerConfig(id);
    if (!config) {
      throw new NotFoundException(`Server with ID "${id}" not found`);
    }
    return config;
  }

  @Post()
  async createServer(@Request() req, @Body(new ValidationPipe()) data: UpdateServerConfigDto) {
    try {
      const id = data.id;
      if (!id) throw new BadRequestException('Server ID is required');
      if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
        throw new BadRequestException('Server ID can only contain letters, numbers, hyphens, and underscores');
      }

      const user = req.user as PayloadToken;
      const settings = await this.settingsService.getSettings(user.userId);

      if (data.serverType === 'AUTO_CURSEFORGE' && !data.cfApiKey) {
        if (settings.cfApiKey) {
          data.cfApiKey = settings.cfApiKey;
        }
      }

      const proxyEnabled = settings.preferences?.proxyEnabled && !!settings.preferences?.proxyBaseDomain;
      const baseDomain = settings.preferences?.proxyBaseDomain;

      const serverConfig = await this.dockerComposeService.createServer(id, data, proxyEnabled);

      // Regenerate routes.json if proxy is enabled (Java only, mc-router doesn't support Bedrock)
      if (proxyEnabled && baseDomain) {
        const servers = await this.dockerComposeService.getAllServerConfigs();
        const proxyServers = servers
          .filter((s) => s.useProxy !== false && s.edition !== 'BEDROCK')
          .map((s) => ({
            id: s.id,
            hostname: s.proxyHostname,
            useProxy: true,
          }));
        await this.proxyService.generateRoutesFile(proxyServers, baseDomain);
      }

      return {
        success: true,
        message: `Server "${id}" created successfully`,
        server: serverConfig,
      };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException(error.message || 'Failed to create server');
    }
  }

  @Post('regenerate-all')
  async regenerateAllDockerCompose(@Request() req) {
    const user = req.user as PayloadToken;
    const settings = await this.settingsService.getSettings(user.userId);
    const proxyEnabled = settings.preferences?.proxyEnabled && !!settings.preferences?.proxyBaseDomain;
    const baseDomain = settings.preferences?.proxyBaseDomain;

    const result = await this.dockerComposeService.regenerateAllDockerCompose(proxyEnabled);

    // Generate routes.json for mc-router if proxy is enabled (Java only)
    if (proxyEnabled && baseDomain) {
      const servers = await this.dockerComposeService.getAllServerConfigs();
      const proxyServers = servers
        .filter((s) => s.useProxy !== false && s.edition !== 'BEDROCK')
        .map((s) => ({
          id: s.id,
          hostname: s.proxyHostname,
          useProxy: true,
        }));
      await this.proxyService.generateRoutesFile(proxyServers, baseDomain);
    }

    return {
      success: true,
      message: `Regenerated ${result.updated.length} servers`,
      ...result,
    };
  }

  @Post('create-from-backup')
  @UseInterceptors(FileInterceptor('file'))
  async createFromBackup(
    @Request() req,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { id?: string; edition?: string; minecraftVersion?: string },
  ) {
    if (!file) {
      throw new BadRequestException('No backup file provided');
    }
    if (!file.originalname.endsWith('.tar.gz')) {
      throw new BadRequestException('Only .tar.gz files are accepted');
    }

    const id = body.id;
    if (!id) throw new BadRequestException('Server ID is required');
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      throw new BadRequestException('Server ID can only contain letters, numbers, hyphens, and underscores');
    }

    const edition = body.edition || 'JAVA';
    const minecraftVersion = body.minecraftVersion || (edition === 'BEDROCK' ? 'LATEST' : 'latest');

    // 1. Create the server (generates docker-compose, mc-data dir, etc.)
    const user = req.user as PayloadToken;
    const settings = await this.settingsService.getSettings(user.userId);
    const proxyEnabled = settings.preferences?.proxyEnabled && !!settings.preferences?.proxyBaseDomain;

    const serverConfig = await this.dockerComposeService.createServer(id, { id, edition, minecraftVersion } as any, proxyEnabled);

    // 2. Extract backup to temp dir to inspect type
    const mcDataPath = path.join(this.SERVERS_DIR, id, 'mc-data');
    const backupsDir = path.join(this.SERVERS_DIR, id, 'backups');
    await fs.ensureDir(backupsDir);

    // Save the uploaded backup file
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const backupFilePath = path.join(backupsDir, safeName);
    await fs.writeFile(backupFilePath, file.buffer);

    const tmpDir = path.join(backupsDir, `.restore-tmp-${Date.now()}`);
    await fs.ensureDir(tmpDir);

    try {
      await execAsync(`tar -xzf "${backupFilePath}" -C "${tmpDir}"`);

      const entries = await fs.readdir(tmpDir);
      const hasServerProperties = entries.includes('server.properties');
      const worldFolders = entries.filter((e) => e === 'world' || e === 'world_nether' || e === 'world_the_end');
      const isWorldOnly = worldFolders.length > 0 && !hasServerProperties;

      if (isWorldOnly) {
        // World-only: start server, wait for it to generate configs, stop, replace world, restart
        this.logger.log(`World-only backup for new server ${id}. Starting initial boot...`);
        await this.managementService.startServer(id);

        // Wait for server to create server.properties (up to 60s)
        const serverPropsPath = path.join(mcDataPath, 'server.properties');
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          if (await fs.pathExists(serverPropsPath)) {
            this.logger.log(`Server ${id} finished initial setup after ${(i + 1) * 2}s`);
            break;
          }
        }

        // Stop the server
        await this.managementService.stopServer(id);
        // Wait a moment for clean shutdown
        await new Promise((r) => setTimeout(r, 3000));

        // Replace world folders
        for (const folder of worldFolders) {
          const targetPath = path.join(mcDataPath, folder);
          if (await fs.pathExists(targetPath)) {
            await fs.remove(targetPath);
          }
          await fs.move(path.join(tmpDir, folder), targetPath);
          this.logger.log(`Restored ${folder} for new server ${id}`);
        }

        // Restart
        await this.managementService.startServer(id);
      } else {
        // Full backup: extract directly into mc-data
        this.logger.log(`Full backup for new server ${id}. Extracting to mc-data...`);
        await fs.emptyDir(mcDataPath);
        for (const entry of entries) {
          await fs.move(path.join(tmpDir, entry), path.join(mcDataPath, entry));
        }
        // Start the server
        await this.managementService.startServer(id);
      }

      return {
        success: true,
        message: `Server "${id}" created from backup successfully`,
        server: serverConfig,
        backupType: isWorldOnly ? 'world-only' : 'full',
      };
    } catch (error) {
      this.logger.error(`Failed to create server ${id} from backup`, error);
      throw new BadRequestException(`Failed to create server from backup: ${(error as Error).message}`);
    } finally {
      await fs.remove(tmpDir).catch(() => {});
    }
  }

  @Delete(':id')
  async deleteServer(@Request() req, @Param('id') id: string) {
    const config = await this.dockerComposeService.getServerConfig(id);
    if (!config) {
      throw new NotFoundException(`Server with ID "${id}" not found`);
    }

    const result = await this.managementService.deleteServer(id);

    // Regenerate routes.json to remove deleted server
    if (result) {
      const user = req.user as PayloadToken;
      const settings = await this.settingsService.getSettings(user.userId);
      const proxyEnabled = settings.preferences?.proxyEnabled && !!settings.preferences?.proxyBaseDomain;
      const baseDomain = settings.preferences?.proxyBaseDomain;

      if (proxyEnabled && baseDomain) {
        const servers = await this.dockerComposeService.getAllServerConfigs();
        
        const proxyServers = servers
          .filter((s) => s.useProxy !== false && s.edition !== 'BEDROCK')
          .map((s) => ({
            id: s.id,
            hostname: s.proxyHostname,
            useProxy: true,
          }));
        await this.proxyService.generateRoutesFile(proxyServers, baseDomain);
      }
    }

    return {
      success: result,
      message: result ? `Server "${id}" deleted successfully` : `Failed to delete server "${id}"`,
    };
  }

  @Get(':id/resources')
  async getServerResources(@Param('id') id: string) {
    const serverExists = await this.dockerComposeService.getServerConfig(id);
    if (!serverExists) {
      throw new NotFoundException(`Server with ID "${id}" not found`);
    }

    const status = await this.managementService.getServerStatus(id);
    if (status === 'not_found') {
      throw new NotFoundException(`Server with ID "${id}" not found`);
    }

    if (status !== 'running') {
      return {
        cpuUsage: 'N/A',
        memoryUsage: 'N/A',
        memoryLimit: 'N/A',
        diskUsage: 'N/A',
        status: status,
      };
    }

    const resources = await this.managementService.getServerResources(id);
    return {
      ...resources,
      status: status,
    };
  }

  @Put(':id')
  async updateServer(@Request() req, @Param('id') id: string, @Body(new ValidationPipe()) config: UpdateServerConfigDto) {
    const user = req.user as PayloadToken;
    const settings = await this.settingsService.getSettings(user.userId);
    const proxyEnabled = settings.preferences?.proxyEnabled && !!settings.preferences?.proxyBaseDomain;
    const baseDomain = settings.preferences?.proxyBaseDomain;

    const updatedConfig = await this.dockerComposeService.updateServerConfig(id, config, proxyEnabled);
    if (!updatedConfig) {
      throw new NotFoundException(`Server with ID "${id}" not found`);
    }

    // Regenerate routes.json if proxy settings changed (Java only)
    if (proxyEnabled && baseDomain && (config.proxyHostname !== undefined || config.useProxy !== undefined)) {
      const servers = await this.dockerComposeService.getAllServerConfigs();
      const proxyServers = servers
        .filter((s) => s.useProxy !== false && s.edition !== 'BEDROCK')
        .map((s) => ({
          id: s.id,
          hostname: s.proxyHostname,
          useProxy: true,
        }));
      await this.proxyService.generateRoutesFile(proxyServers, baseDomain);
    }

    return updatedConfig;
  }

  @Post(':id/restart')
  async restartServer(@Param('id') id: string) {
    const result = await this.managementService.restartServer(id);
    return {
      success: result,
      message: result ? 'Server restarted successfully' : 'Failed to restart server',
    };
  }

  @Post(':id/clear-data')
  async clearServerData(@Param('id') id: string) {
    const config = await this.dockerComposeService.getServerConfig(id);
    if (!config) {
      throw new NotFoundException(`Server with ID "${id}" not found`);
    }

    const result = await this.managementService.clearServerData(id);
    return {
      success: result,
      message: result ? 'Server data cleared successfully' : 'Failed to clear server data',
    };
  }

  @Get(':id/status')
  async getServerStatus(@Param('id') id: string) {
    const status = await this.managementService.getServerStatus(id);
    return { status };
  }

  @Get(':id/info')
  async getServerInfo(@Param('id') id: string) {
    const serverInfo = await this.managementService.getServerInfo(id);
    if (!serverInfo.exists) {
      throw new NotFoundException(`Server with ID "${id}" not found`);
    }

    const config = await this.dockerComposeService.getServerConfig(id);
    return { ...serverInfo, config: config || undefined };
  }

  @Get(':id/logs')
  async getServerLogs(@Param('id') id: string, @Query('lines') lines?: number, @Query('since') since?: string, @Query('stream') stream?: string) {
    const lineCount = lines && lines > 0 ? Math.min(lines, 10000) : 100;

    if (stream === 'true' && since) {
      return this.managementService.getServerLogsStream(id, lineCount, since);
    }
    if (since) {
      return this.managementService.getServerLogsSince(id, since);
    }
    return this.managementService.getServerLogs(id, lineCount);
  }

  @Get(':id/logs/stream')
  async getServerLogsStream(@Param('id') id: string, @Query('lines') lines?: number, @Query('since') since?: string) {
    const lineCount = lines && lines > 0 ? Math.min(lines, 5000) : 500;
    return this.managementService.getServerLogsStream(id, lineCount, since);
  }

  @Get(':id/logs/since/:timestamp')
  async getServerLogsSince(@Param('id') id: string, @Param('timestamp') timestamp: string) {
    return this.managementService.getServerLogsSince(id, timestamp);
  }

  @Post(':id/command')
  async executeCommand(@Param('id') id: string, @Body() body: { command: string; rconPort: string; rconPassword?: string }) {
    return this.managementService.executeCommand(id, body.command, body.rconPort, body.rconPassword);
  }

  @Post(':id/start')
  async startServer(@Param('id') id: string) {
    const result = await this.managementService.startServer(id);
    return {
      success: result,
      message: result ? 'Server started successfully' : 'Failed to start server',
    };
  }

  @Post(':id/stop')
  async stopServer(@Param('id') id: string) {
    const result = await this.managementService.stopServer(id);
    return {
      success: result,
      message: result ? 'Server stopped successfully' : 'Failed to stop server',
    };
  }

  @Post(':id/players/online')
  async getOnlinePlayers(@Param('id') id: string, @Body() body: { rconPort: string; rconPassword?: string }) {
    return this.managementService.getOnlinePlayers(id, body.rconPort, body.rconPassword);
  }

  @Get(':id/players/whitelist')
  async getWhitelist(@Param('id') id: string) {
    return this.managementService.getWhitelist(id);
  }

  @Get(':id/players/ops')
  async getOps(@Param('id') id: string) {
    return this.managementService.getOps(id);
  }

  @Get(':id/players/banned')
  async getBannedPlayers(@Param('id') id: string) {
    return this.managementService.getBannedPlayers(id);
  }
}
