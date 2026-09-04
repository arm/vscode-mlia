const numberLocale = "en-US";
const significantFigures = 2;
const maximumDecimalPlaces = 20;

/** Formats UI numbers with grouping and two significant figures of precision. */
export function formatDisplayNumber(value: number): string {
  if (value === 0) {
    return "0";
  }
  const decimalPlaces = Math.max(
    0,
    significantFigures - 1 - Math.floor(Math.log10(Math.abs(value))),
  );
  if (decimalPlaces > maximumDecimalPlaces) {
    return value.toPrecision(significantFigures);
  }
  return new Intl.NumberFormat(numberLocale, {
    maximumFractionDigits: decimalPlaces,
    useGrouping: true,
  }).format(value);
}
