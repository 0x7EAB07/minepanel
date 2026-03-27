import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ServerManagementController } from './server-management.controller';
import { ServerManagementService } from './server-management.service';
import { DockerComposeService } from 'src/docker-compose/docker-compose.service';
import { DiscordModule } from 'src/discord/discord.module';
import { UsersModule } from 'src/users/users.module';
import { ProxyModule } from 'src/proxy/proxy.module';
import { Settings } from 'src/users/entities/settings.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Settings]), DiscordModule, UsersModule, ProxyModule, ConfigModule],
  controllers: [ServerManagementController],
  providers: [ServerManagementService, DockerComposeService],
})
export class ServerManagementModule {}
