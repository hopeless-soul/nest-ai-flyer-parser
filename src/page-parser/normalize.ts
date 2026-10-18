import {
  ProductCategoryKeys,
  type ProductCategoryKey,
} from '../flyers/types/product-category.type';
import { InvalidResponseError } from './page-parser.errors';

/** Place of an offer on the page as 0–1 fractions: top-left and bottom-right corners */
export type BoundaryBox = [[number, number], [number, number]];

/** One offer validated from the model answer, before it gets its page/flyer columns */
export interface NormalizedOffer {
  title: string;
  /** null means the category is not known */
  category: ProductCategoryKey[] | null;
  boundaryBox: BoundaryBox;
  /** Prices in EUR; null if not printed */
  basePrice: number | null;
  discountedPrice: number | null;
  /** Percent, e.g. 25 */
  discount: number | null;
  loyaltyPrice: number | null;
  loyaltyDiscount: number | null;
}

/** Round to `digits` decimals */
const round = (value: number, digits: number): number =>
  Number(value.toFixed(digits));
/** Clamp to [min, max] */
const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));
/** true for a finite number */
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** A non-negative price rounded to cents, otherwise null */
function toPrice(value: unknown): number | null {
  return isFiniteNumber(value) && value >= 0 ? round(value, 2) : null;
}

/**
 * Convert Gemini `box_2d` ([ymin, xmin, ymax, xmax], 0–1000) to 0–1 corners
 * @returns null if the box is malformed or has no area
 */
function toBoundaryBox(value: unknown): BoundaryBox | null {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every(isFiniteNumber)
  )
    return null;

  const [a, b, c, d] = value.map((n) => clamp(n, 0, 1000) / 1000);
  const [y1, y2] = a <= c ? [a, c] : [c, a];
  const [x1, x2] = b <= d ? [b, d] : [d, b];
  if (x2 - x1 <= 0 || y2 - y1 <= 0) return null;

  return [
    [round(x1, 4), round(y1, 4)],
    [round(x2, 4), round(y2, 4)],
  ];
}

/** Known category keys only, without duplicates; null if none remain */
function toCategories(value: unknown): ProductCategoryKey[] | null {
  if (!Array.isArray(value)) return null;
  const known = (value as unknown[]).filter((key): key is ProductCategoryKey =>
    (ProductCategoryKeys as readonly unknown[]).includes(key),
  );
  return known.length ? [...new Set(known)] : null;
}

/**
 * Printed discount if valid, otherwise computed from both prices
 * Note: Always null without the promotional price; a discount never stands without its price
 */
function toDiscount(
  value: unknown,
  basePrice: number | null,
  promoPrice: number | null,
): number | null {
  if (promoPrice === null) return null;
  if (isFiniteNumber(value) && value > 0 && value < 100)
    return Math.round(value);
  if (basePrice && promoPrice < basePrice) {
    return Math.round((1 - promoPrice / basePrice) * 100);
  }
  return null;
}

/**
 * Validate the model answer of one page and convert it to offers
 * Note: Invalid offers and offers without any discount are dropped (reported via `onDrop`)
 * @throws InvalidResponseError if the answer is not JSON with a `products` array
 */
export function normalizePage(
  text: string | undefined,
  onDrop: (reason: string) => void,
): NormalizedOffer[] {
  let data: unknown;
  try {
    data = JSON.parse(text ?? '');
  } catch {
    throw new InvalidResponseError('Response is not valid JSON');
  }

  const items = (data as { products?: unknown } | null)?.products;
  if (!Array.isArray(items)) {
    throw new InvalidResponseError('Response has no "products" array');
  }

  const offers: NormalizedOffer[] = [];
  for (const item of items as Record<string, unknown>[]) {
    const title =
      typeof item?.title === 'string'
        ? item.title.replace(/\s+/g, ' ').trim()
        : '';
    const boundaryBox = toBoundaryBox(item?.box_2d);

    if (!title || !boundaryBox) {
      onDrop(!title ? 'no title' : `invalid box: ${title}`);
      continue;
    }

    const basePrice = toPrice(item.basePrice);
    const discountedPrice = toPrice(item.discountedPrice);
    const loyaltyPrice = toPrice(item.loyaltyPrice);
    const discount = toDiscount(
      item.discountPercent,
      basePrice,
      discountedPrice,
    );
    const loyaltyDiscount = toDiscount(
      item.loyaltyDiscountPercent,
      basePrice,
      loyaltyPrice,
    );

    // Note: The prompt asks for discounted offers only, but the model still returns some regular-price offers
    if (discount === null && loyaltyDiscount === null) {
      onDrop(`no discount: ${title}`);
      continue;
    }

    offers.push({
      title,
      category: toCategories(item.category),
      boundaryBox,
      basePrice,
      discountedPrice,
      discount,
      loyaltyPrice,
      loyaltyDiscount,
    });
  }
  return offers;
}
