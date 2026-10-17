// Types for the vendored qrcode-generator (the API subset the app uses; see README.md).
type ErrorCorrectionLevel = "L" | "M" | "Q" | "H";
interface QRCode {
  addData(data: string, mode?: "Numeric" | "Alphanumeric" | "Byte" | "Kanji"): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, col: number): boolean;
}
interface QRCodeFactory {
  (typeNumber: number, errorCorrectionLevel: ErrorCorrectionLevel): QRCode;
}
declare const qrcode: QRCodeFactory;
export = qrcode;
