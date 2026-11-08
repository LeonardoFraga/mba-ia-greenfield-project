import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { SignPartsDto } from './dto/sign-parts.dto';
import type {
  CompleteUploadResult,
  InitiateUploadResult,
  SignedPart,
} from './videos.service';
import { VideosService } from './videos.service';

/** Shared `schema` fragment: every error in the API uses one envelope. */
const envelope = { schema: { $ref: getSchemaPath(ApiErrorEnvelope) } };

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Initiate a video upload',
    description:
      'Pre-registers the video as a draft and opens a multipart upload, returning the part size and count the client needs to slice the file. The bytes never pass through the API.',
  })
  @ApiResponse({ status: 201, description: 'Upload initiated' })
  @ApiResponse({ status: 400, description: 'Validation failed', ...envelope })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    ...envelope,
  })
  @ApiResponse({
    status: 404,
    description: 'Authenticated user has no channel',
    ...envelope,
  })
  @ApiResponse({
    status: 413,
    description: 'Declared size above the upload ceiling',
    ...envelope,
  })
  @ApiResponse({
    status: 415,
    description: 'Content type is not an accepted video container',
    ...envelope,
  })
  async initiate(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<InitiateUploadResult> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':id/parts')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Sign upload part URLs',
    description:
      'Mints presigned URLs the client PUTs each part to, directly to object storage.',
  })
  @ApiResponse({ status: 200, description: 'Part URLs signed' })
  @ApiResponse({ status: 400, description: 'Validation failed', ...envelope })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    ...envelope,
  })
  @ApiResponse({
    status: 403,
    description: 'Video belongs to another channel',
    ...envelope,
  })
  @ApiResponse({ status: 404, description: 'Video not found', ...envelope })
  @ApiResponse({
    status: 409,
    description: 'Video has no upload in progress',
    ...envelope,
  })
  async signParts(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SignPartsDto,
  ): Promise<{ parts: SignedPart[] }> {
    return { parts: await this.videosService.signParts(user.sub, id, dto) };
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Assembles the parts, verifies the stored object against the declared size and enqueues processing.',
  })
  @ApiResponse({ status: 200, description: 'Upload completed and enqueued' })
  @ApiResponse({ status: 400, description: 'Validation failed', ...envelope })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    ...envelope,
  })
  @ApiResponse({
    status: 403,
    description: 'Video belongs to another channel',
    ...envelope,
  })
  @ApiResponse({ status: 404, description: 'Video not found', ...envelope })
  @ApiResponse({
    status: 409,
    description:
      'Upload is not in progress, or the stored object does not match the declared size',
    ...envelope,
  })
  async complete(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    return this.videosService.completeUpload(user.sub, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Abort a video upload',
    description:
      'Aborts the multipart upload in storage and discards the draft row.',
  })
  @ApiResponse({ status: 204, description: 'Upload aborted' })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    ...envelope,
  })
  @ApiResponse({
    status: 403,
    description: 'Video belongs to another channel',
    ...envelope,
  })
  @ApiResponse({ status: 404, description: 'Video not found', ...envelope })
  async abort(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.videosService.abortUpload(user.sub, id);
  }
}
