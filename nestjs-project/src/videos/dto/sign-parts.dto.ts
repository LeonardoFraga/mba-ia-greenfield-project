import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  Max,
  Min,
} from 'class-validator';
import {
  MAX_PART_NUMBER,
  MAX_PARTS_PER_SIGN_REQUEST,
  MIN_PART_NUMBER,
} from '../videos.constants';

export class SignPartsDto {
  /** Números das partes a assinar, de 1 a 10000. */
  // The range is an S3 platform limit; the batch cap keeps one request from
  // asking for every URL of a 10GB upload at once.
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PARTS_PER_SIGN_REQUEST)
  @IsInt({ each: true })
  @Min(MIN_PART_NUMBER, { each: true })
  @Max(MAX_PART_NUMBER, { each: true })
  partNumbers: number[];
}
