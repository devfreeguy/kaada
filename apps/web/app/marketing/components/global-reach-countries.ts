import type { StaticImageData } from "next/image";
import coin0 from "../../../assets/flags/coins/nigerian-flag-coin.webp";
import coin1 from "../../../assets/flags/coins/brazilian-flag-coin.webp";
import coin2 from "../../../assets/flags/coins/argentina-flag-coin.webp";
import coin3 from "../../../assets/flags/coins/indonesian-flag-coin.webp";
import coin4 from "../../../assets/flags/coins/mexican-flag-coin.webp";
import coin5 from "../../../assets/flags/coins/colombian-flag-coin.webp";
import coin6 from "../../../assets/flags/coins/chilean-flag-coin.webp";
import coin7 from "../../../assets/flags/coins/peru-flag-coin.webp";
import coin8 from "../../../assets/flags/coins/american-flag-coin.webp";

export type SupportedCountry = {
  id: string;
  country: string;
  currency: string;
  code: string;
  symbol: string;
  coordinates: [number, number];
  coin: StaticImageData;
  coinSize: number;
};

export const supportedCountries: SupportedCountry[] = [
  {
    id: "566",
    country: "Nigeria",
    currency: "Nigerian Naira",
    code: "NGN",
    symbol: "₦",
    coordinates: [8.6753, 9.082],
    coin: coin0,
    coinSize: 30,
  },
  {
    id: "076",
    country: "Brazil",
    currency: "Brazilian Real",
    code: "BRL",
    symbol: "R$",
    coordinates: [-51.9253, -14.235],
    coin: coin1,
    coinSize: 64,
  },
  {
    id: "032",
    country: "Argentina",
    currency: "Argentine Peso",
    code: "ARS",
    symbol: "AR$",
    coordinates: [-63.6167, -38.4161],
    coin: coin2,
    coinSize: 42,
  },
  {
    id: "360",
    country: "Indonesia",
    currency: "Indonesian Rupiah",
    code: "IDR",
    symbol: "Rp",
    coordinates: [113.9213, -0.7893],
    coin: coin3,
    coinSize: 32,
  },
  {
    id: "484",
    country: "Mexico",
    currency: "Mexican Peso",
    code: "MXN",
    symbol: "MX$",
    coordinates: [-102.5528, 23.6345],
    coin: coin4,
    coinSize: 44,
  },
  {
    id: "170",
    country: "Colombia",
    currency: "Colombian Peso",
    code: "COP",
    symbol: "COL$",
    coordinates: [-74.2973, 4.5709],
    coin: coin5,
    coinSize: 30,
  },
  {
    id: "152",
    country: "Chile",
    currency: "Chilean Peso",
    code: "CLP",
    symbol: "CLP$",
    coordinates: [-71.543, -35.6751],
    coin: coin6,
    coinSize: 24,
  },
  {
    id: "604",
    country: "Peru",
    currency: "Peruvian Sol",
    code: "PEN",
    symbol: "S/",
    coordinates: [-75.0152, -9.19],
    coin: coin7,
    coinSize: 32,
  },
  {
    id: "840",
    country: "United States",
    currency: "US Dollar",
    code: "USD",
    symbol: "$",
    coordinates: [-98.5795, 39.8283],
    coin: coin8,
    coinSize: 64,
  },
];
