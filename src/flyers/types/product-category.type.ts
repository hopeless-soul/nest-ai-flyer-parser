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
  'household&cleaning'
] as const
export type ProductCategoryKey = (typeof ProductCategoryKeys)[number]