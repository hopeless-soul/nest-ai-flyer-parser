export const ProductCategoryKeys = [
  'other',
  'bakery',
  'fruits',
  'vegetables',
  'meat',
  'seafood',
  'sport',
  'beverages',
  'snacks',
  'grains&pasta',
  'sauces',
  'household&cleaning',
  // TODO: Cover new categories at frontend as well
  'nonfood',
  'sportsfood',
  'pet',
  'sweets',
  'milk&dairy',
  'baby'
] as const;
export type ProductCategoryKey = (typeof ProductCategoryKeys)[number];
