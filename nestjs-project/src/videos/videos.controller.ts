import {
  Body,
  Controller,
  Delete,
  Get,
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
import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import type { SignedUrl } from '../storage/storage.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { SignPartsDto } from './dto/sign-parts.dto';
import type {
  CompleteUploadResult,
  InitiateUploadResult,
  PublicVideo,
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

  // --- Public delivery ---------------------------------------------------
  // Gated on the video's state, not on the caller's identity: a URL is issued
  // only for a `ready` video, and every other status answers the same 404 as a
  // publicId that never existed.

  @Public()
  @Get(':publicId/stream')
  @ApiOperation({
    summary: 'Get a streaming URL',
    description:
      'Returns a short-lived presigned URL the player uses as its source. Object storage answers the range requests, so playback never needs the whole file.',
  })
  @ApiResponse({ status: 200, description: 'Streaming URL issued' })
  @ApiResponse({
    status: 404,
    description: 'No ready video with this public id',
    ...envelope,
  })
  async stream(@Param('publicId') publicId: string): Promise<SignedUrl> {
    return this.videosService.streamUrl(publicId);
  }

  @Public()
  @Get(':publicId/download')
  @ApiOperation({
    summary: 'Get a download URL',
    description:
      'The same presigned mechanism as streaming, with a content-disposition override so the browser saves the file.',
  })
  @ApiResponse({ status: 200, description: 'Download URL issued' })
  @ApiResponse({
    status: 404,
    description: 'No ready video with this public id',
    ...envelope,
  })
  async download(@Param('publicId') publicId: string): Promise<SignedUrl> {
    return this.videosService.downloadUrl(publicId);
  }

  @Public()
  @Get(':publicId')
  @ApiOperation({
    summary: 'Get public video metadata',
    description:
      'Public metadata for a ready video, including the permanent thumbnail URL.',
  })
  @ApiResponse({ status: 200, description: 'Video metadata' })
  @ApiResponse({
    status: 404,
    description: 'No ready video with this public id',
    ...envelope,
  })
  async findPublic(@Param('publicId') publicId: string): Promise<PublicVideo> {
    return this.videosService.findPublicByPublicId(publicId);
  }
}
