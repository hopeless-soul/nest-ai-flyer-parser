import type { ShopKey } from '../shops/shop.config.type';
import { FLYER_OBJECT_PREFIX } from '../storage/r2.service';

/** Page id: `kaufland_2026-10-14_2026-10-20` + 7 → `kaufland_2026-10-14_2026-10-20_page_07` */
export function pageIdOf(flyerId: string, pageNumber: number): string {
  return `${flyerId}_page_${String(pageNumber).padStart(2, '0')}`;
}

/**
 * R2 key of a page image: `flyers/<shop>/<flyerId>/pages/<pageId>.<hash8>.<ext>`
 * Note: The hash part makes a changed image a new key, so caches never serve a stale page
 */
export function pageImageKey(
  shop: ShopKey,
  flyerId: string,
  pageId: string,
  imageHash: string,
  ext: string,
): string {
  return `${FLYER_OBJECT_PREFIX}${shop}/${flyerId}/pages/${pageId}.${imageHash.slice(0, 8)}.${ext}`;
}
