import { ApiProperty } from '@nestjs/swagger';
import { PageStatus } from '../enums/page.enums';

/** A flyer page for the frontend, with a stable image URL */
export class PageDto {
  /** e.g. kaufland_2026-10-14_2026-10-20_page_07 */
  id!: string;
  /** 1-based */
  pageNumber!: number;
  @ApiProperty({ enum: PageStatus, enumName: 'PageStatus' })
  status!: PageStatus;
  /** Pixels */
  width!: number | null;
  /** Pixels */
  height!: number | null;
  /** Stable URL (`GET /pages/:id/image`, redirects to R2), safe to store; null when the image is not in R2 */
  imageUrl!: string | null;
}
