import qrcode from "./vendor/qrcode-generator.cjs";

/**
 * A QR code as a square matrix of dark/light modules (error correction M, the smallest version that fits). Pure and offline: the
 * text, which may be a secret, is encoded in this page and goes nowhere.
 */
export function qrMatrix(text: string): boolean[][] {
  const code = qrcode(0, "M");
  code.addData(text, "Byte");
  code.make();
  const size = code.getModuleCount();
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) => code.isDark(row, column)),
  );
}
