// export type SourceOption = {
//   flyerDataUrl: string
//   apiUrl: string
// }

export const ShopKeys = [
  'kaufland',
  'tesco',
  'lidl',
  'billa',
] as const

export type ShopKey = (typeof ShopKeys)[number]