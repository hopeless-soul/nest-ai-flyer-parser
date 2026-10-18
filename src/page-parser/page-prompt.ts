import { ProductCategoryKeys } from '../flyers/types/product-category.type';

/**
 * Bump when the prompt or the offer shape changes, so pages parsed by an older version are parsed again
 */
export const PARSER_VERSION = 3;

/**
 * Output token cap of one page answer
 * Note: A page answer is ~85 tokens per offer; the cap only stops a looping answer (the model default is 65k)
 */
export const PARSER_MAX_OUTPUT_TOKENS = 8192;

/**
 * Instructions sent with every page image
 * Note: Flyers are Slovak, prices are EUR with a decimal comma
 * Note: Every output token costs ~8x an input token, so titles leave out unit prices and notes
 */
export const PAGE_PROMPT = `Supermarket flyer page from Slovakia, prices in EUR. List its discounted product offers.

Rules:
- If the page has no product offers (cover, adverts, recipes, articles, store info), return {"products": []} immediately.
- Include an offer only if it shows a promotional price and a discount: a printed percent (e.g. "-25 %") or a regular price ("bežná cena", often struck through).
- Skip multi-buy deals ("1 + 1", "2 + 2", "3 za 2", "Kúpte 2 zaplaťte 1", "druhý kus zadarmo") and offers without a discount.
- A label printed under or next to a price belongs to that price. A price labeled with a loyalty card or app is a loyalty price, never a price for everyone: "Clubcard cena", "S Clubcard", "Cena s kupónom v aplikácii Clubcard", "XTRA", "K-Card", "Lidl Plus", "BILLA Bonus", "S kupónom", "s aplikáciou". "Cena pre všetkých" is for everyone.

Fields:
- title: product name as printed, with brand, variant and pack size, in the original language. Leave out prices, unit prices ("1 kg = 4,30") and notes like "viac druhov" or "voľný predaj".
- category: the allowed categories that fit; "other" if none does.
- box_2d: [ymin, xmin, ymax, xmax] of the whole offer (image, name and prices), 0-1000.
- basePrice: regular price before the discount.
- discountedPrice: promotional price for everyone.
- discountPercent: printed percent for discountedPrice ("-25 %" -> 25).
- loyaltyPrice: lowest loyalty price.
- loyaltyDiscountPercent: printed percent for loyaltyPrice.
Use null for anything not printed. Prices use a decimal point: "1,99" -> 1.99.`;

/**
 * Sent as `systemInstruction`
 * Note: Without it the model pretty-prints the JSON, a third of its output tokens were whitespace.
 *       The same line inside the prompt was ignored half the time.
 */
export const PAGE_SYSTEM_INSTRUCTION =
  'Respond with minified JSON on a single line: no indentation, no line breaks, no spaces between tokens.';

/** Structured output schema, sent as `responseJsonSchema` */
export const PAGE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    products: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          category: {
            type: 'array',
            items: { type: 'string', enum: [...ProductCategoryKeys] },
          },
          box_2d: {
            type: 'array',
            items: { type: 'integer' },
            minItems: 4,
            maxItems: 4,
          },
          basePrice: { type: ['number', 'null'] },
          discountedPrice: { type: ['number', 'null'] },
          discountPercent: { type: ['integer', 'null'] },
          loyaltyPrice: { type: ['number', 'null'] },
          loyaltyDiscountPercent: { type: ['integer', 'null'] },
        },
        required: [
          'title',
          'category',
          'box_2d',
          'basePrice',
          'discountedPrice',
          'discountPercent',
          'loyaltyPrice',
          'loyaltyDiscountPercent',
        ],
      },
    },
  },
  required: ['products'],
};
