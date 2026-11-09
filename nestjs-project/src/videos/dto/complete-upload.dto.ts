import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { MAX_PART_NUMBER, MIN_PART_NUMBER } from '../videos.constants';
import { IsConsecutiveFromOne } from './consecutive-parts.validator';

export class CompletedPartDto {
  /** Número da parte, de 1 a 10000. */
  @IsInt()
  @Min(MIN_PART_NUMBER)
  @Max(MAX_PART_NUMBER)
  partNumber: number;

  /** ETag devolvida pelo storage no PUT daquela parte. */
  @IsString()
  @MinLength(1)
  etag: string;
}

export class CompleteUploadDto {
  /** Partes enviadas, começando em 1 e sem lacunas. */
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  @IsConsecutiveFromOne()
  parts: CompletedPartDto[];
}
