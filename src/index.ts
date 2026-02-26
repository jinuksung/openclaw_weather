import { config as dotenvConfig } from "dotenv";

const SEOUL_LATITUDE = 37.5665;
const SEOUL_LONGITUDE = 126.9780;
const SEOUL_TIMEZONE = "Asia/Seoul";

const WEATHER_API_URL =
  `https://api.open-meteo.com/v1/forecast?latitude=${SEOUL_LATITUDE}` +
  `&longitude=${SEOUL_LONGITUDE}` +
  `&daily=temperature_2m_max,temperature_2m_min` +
  `&timezone=${encodeURIComponent(SEOUL_TIMEZONE)}`;

const AIR_API_URL =
  `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${SEOUL_LATITUDE}` +
  `&longitude=${SEOUL_LONGITUDE}` +
  `&hourly=pm10,pm2_5` +
  `&timezone=${encodeURIComponent(SEOUL_TIMEZONE)}`;

type NullableNumber = number | null;

export interface DailyTemperature {
  min: NullableNumber;
  max: NullableNumber;
}

export interface PeriodAverage {
  morning: NullableNumber;
  afternoon: NullableNumber;
}

export interface AirDaySummary {
  pm10: PeriodAverage;
  pm2_5: PeriodAverage;
}

export type WeatherByDate = Record<string, DailyTemperature>;
export type AirPeriodSummaryByDate = Record<string, AirDaySummary>;

export interface WeekendDates {
  saturday: string;
  sunday: string;
}

export interface BuildReportMessageInput {
  todayDate: string;
  weekend: WeekendDates;
  weatherByDate: WeatherByDate;
  airByDate: AirPeriodSummaryByDate;
}

interface WeatherApiResponse {
  daily?: {
    time?: string[];
    temperature_2m_min?: Array<number | null>;
    temperature_2m_max?: Array<number | null>;
  };
}

interface AirApiResponse {
  hourly?: {
    time?: string[];
    pm10?: Array<number | null>;
    pm2_5?: Array<number | null>;
  };
}

interface TelegramConfig {
  botToken: string;
  chatId: string;
}

class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

class SourceApiError extends Error {
  readonly source: "Weather API" | "Air API";

  constructor(source: "Weather API" | "Air API", message: string) {
    super(message);
    this.name = "SourceApiError";
    this.source = source;
  }
}

export function loadEnvFromDotenvFile(envFilePath = ".env"): void {
  const result = dotenvConfig({ path: envFilePath, quiet: true });

  if (!result.error) {
    return;
  }

  const error = result.error as NodeJS.ErrnoException;
  if (error.code === "ENOENT") {
    return;
  }

  throw new ConfigError(`.env 파일 로드 실패: ${error.message}`);
}

function emptyAirDaySummary(): AirDaySummary {
  return {
    pm10: { morning: null, afternoon: null },
    pm2_5: { morning: null, afternoon: null },
  };
}

function parseDateOnly(dateYmd: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateYmd);
  if (!match) {
    throw new Error(`유효하지 않은 날짜 형식: ${dateYmd}`);
  }

  const [, year, month, day] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
}

function formatDateOnlyUtc(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function getClosestWeekendDates(todayDateYmd: string): WeekendDates {
  const today = parseDateOnly(todayDateYmd);
  const dayOfWeek = today.getUTCDay(); // 0: Sun ... 6: Sat
  const daysUntilSaturday = (6 - dayOfWeek + 7) % 7;
  const saturday = addUtcDays(today, daysUntilSaturday);
  const sunday = addUtcDays(saturday, 1);

  return {
    saturday: formatDateOnlyUtc(saturday),
    sunday: formatDateOnlyUtc(sunday),
  };
}

export function getKstTodayDate(now: Date = new Date()): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: SEOUL_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = formatter.formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    throw new Error("KST 날짜 계산에 실패했습니다.");
  }

  return `${year}-${month}-${day}`;
}

export function mapWeatherDailyByDate(response: WeatherApiResponse): WeatherByDate {
  const time = response.daily?.time;
  const min = response.daily?.temperature_2m_min;
  const max = response.daily?.temperature_2m_max;

  if (!Array.isArray(time) || !Array.isArray(min) || !Array.isArray(max)) {
    throw new Error("Weather API 응답에 daily.time/min/max 배열이 없습니다.");
  }

  if (time.length !== min.length || time.length !== max.length) {
    throw new Error("Weather API 응답 배열 길이가 일치하지 않습니다.");
  }

  const result: WeatherByDate = {};

  for (let i = 0; i < time.length; i += 1) {
    result[time[i]] = {
      min: typeof min[i] === "number" ? min[i] : null,
      max: typeof max[i] === "number" ? max[i] : null,
    };
  }

  return result;
}

function average(values: number[]): NullableNumber {
  if (values.length === 0) {
    return null;
  }

  const sum = values.reduce((acc, value) => acc + value, 0);
  return sum / values.length;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function aggregateAirQualityByDate(response: AirApiResponse): AirPeriodSummaryByDate {
  const time = response.hourly?.time;
  const pm10 = response.hourly?.pm10;
  const pm2_5 = response.hourly?.pm2_5;

  if (!Array.isArray(time) || !Array.isArray(pm10) || !Array.isArray(pm2_5)) {
    throw new Error("Air API 응답에 hourly.time/pm10/pm2_5 배열이 없습니다.");
  }

  if (time.length !== pm10.length || time.length !== pm2_5.length) {
    throw new Error("Air API 응답 배열 길이가 일치하지 않습니다.");
  }

  type Bucket = {
    pm10: { morning: number[]; afternoon: number[] };
    pm2_5: { morning: number[]; afternoon: number[] };
  };

  const buckets: Record<string, Bucket> = {};

  for (let i = 0; i < time.length; i += 1) {
    const iso = time[i];
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):/.exec(iso);
    if (!match) {
      continue;
    }

    const date = match[1];
    const hour = Number(match[2]);

    if (!buckets[date]) {
      buckets[date] = {
        pm10: { morning: [], afternoon: [] },
        pm2_5: { morning: [], afternoon: [] },
      };
    }

    let period: keyof PeriodAverage | null = null;
    if (hour >= 6 && hour <= 11) {
      period = "morning";
    } else if (hour >= 12 && hour <= 17) {
      period = "afternoon";
    }

    if (!period) {
      continue;
    }

    const pm10Value = pm10[i];
    const pm25Value = pm2_5[i];

    if (isFiniteNumber(pm10Value)) {
      buckets[date].pm10[period].push(pm10Value);
    }
    if (isFiniteNumber(pm25Value)) {
      buckets[date].pm2_5[period].push(pm25Value);
    }
  }

  const result: AirPeriodSummaryByDate = {};

  for (const [date, bucket] of Object.entries(buckets)) {
    result[date] = {
      pm10: {
        morning: average(bucket.pm10.morning),
        afternoon: average(bucket.pm10.afternoon),
      },
      pm2_5: {
        morning: average(bucket.pm2_5.morning),
        afternoon: average(bucket.pm2_5.afternoon),
      },
    };
  }

  return result;
}

function roundToOneDecimal(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function formatRoundedNumber(value: NullableNumber): string {
  if (value === null) {
    return "데이터없음";
  }

  const rounded = roundToOneDecimal(value);
  if (Number.isInteger(rounded)) {
    return String(rounded);
  }
  return rounded.toFixed(1);
}

function formatTemperature(value: NullableNumber): string {
  if (value === null) {
    return "데이터없음";
  }
  return `${formatRoundedNumber(value)}°C`;
}

function formatPeriodPair(period: PeriodAverage, includeUnit: boolean): string {
  const pair = `${formatRoundedNumber(period.morning)} / ${formatRoundedNumber(period.afternoon)}`;
  return includeUnit ? `${pair} µg/m³` : pair;
}

export function buildReportMessage(input: BuildReportMessageInput): string {
  const todayWeather = input.weatherByDate[input.todayDate] ?? { min: null, max: null };
  const todayAir = input.airByDate[input.todayDate] ?? emptyAirDaySummary();

  const saturdayWeather = input.weatherByDate[input.weekend.saturday] ?? { min: null, max: null };
  const sundayWeather = input.weatherByDate[input.weekend.sunday] ?? { min: null, max: null };
  const saturdayAir = input.airByDate[input.weekend.saturday] ?? emptyAirDaySummary();
  const sundayAir = input.airByDate[input.weekend.sunday] ?? emptyAirDaySummary();

  const lines = [
    `[서울] 오늘(${input.todayDate})`,
    `🌡️ 최저/최고: ${formatTemperature(todayWeather.min)} / ${formatTemperature(todayWeather.max)}`,
    `😷 미세먼지 PM10 오전/오후: ${formatPeriodPair(todayAir.pm10, true)}`,
    `🫁 초미세먼지 PM2.5 오전/오후: ${formatPeriodPair(todayAir.pm2_5, true)}`,
    "",
    "[주말]",
    `토(${input.weekend.saturday}) 🌡️ ${formatTemperature(saturdayWeather.min)} / ${formatTemperature(saturdayWeather.max)}`,
    `  😷 PM10 오전/오후: ${formatPeriodPair(saturdayAir.pm10, false)}`,
    `  🫁 PM2.5 오전/오후: ${formatPeriodPair(saturdayAir.pm2_5, false)}`,
    `일(${input.weekend.sunday}) 🌡️ ${formatTemperature(sundayWeather.min)} / ${formatTemperature(sundayWeather.max)}`,
    `  😷 PM10 오전/오후: ${formatPeriodPair(sundayAir.pm10, false)}`,
    `  🫁 PM2.5 오전/오후: ${formatPeriodPair(sundayAir.pm2_5, false)}`,
  ];

  return lines.join("\n");
}

function getRequiredEnv(name: "TELEGRAM_BOT_TOKEN" | "TELEGRAM_CHAT_ID"): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new ConfigError(
      "필수 환경변수가 없습니다. TELEGRAM_BOT_TOKEN 과 TELEGRAM_CHAT_ID 를 설정한 뒤 다시 실행하세요.",
    );
  }
  return value;
}

function getTelegramConfigFromEnv(): TelegramConfig {
  return {
    botToken: getRequiredEnv("TELEGRAM_BOT_TOKEN"),
    chatId: getRequiredEnv("TELEGRAM_CHAT_ID"),
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function fetchJson<T>(url: string, source: "Weather API" | "Air API"): Promise<T> {
  let response: Response;

  try {
    response = await fetch(url);
  } catch (error) {
    throw new SourceApiError(source, `${source} 요청 실패: ${errorMessage(error)}`);
  }

  if (!response.ok) {
    let bodyPreview = "";
    try {
      bodyPreview = await response.text();
    } catch {
      bodyPreview = "";
    }

    const trimmedBody = bodyPreview.trim();
    const suffix = trimmedBody ? ` - ${trimmedBody.slice(0, 300)}` : "";
    throw new SourceApiError(source, `${source} 응답 오류 (HTTP ${response.status})${suffix}`);
  }

  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new SourceApiError(source, `${source} JSON 파싱 실패: ${errorMessage(error)}`);
  }
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function sendTelegramMessage(config: TelegramConfig, text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: config.chatId,
      text: escapeHtml(text),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch {
      body = "";
    }
    const suffix = body.trim() ? ` - ${body.trim().slice(0, 300)}` : "";
    throw new Error(`Telegram sendMessage 실패 (HTTP ${response.status})${suffix}`);
  }
}

function buildFailureMessage(error: unknown): string {
  const reason = errorMessage(error);

  if (error instanceof SourceApiError) {
    return `[서울] 날씨/미세먼지 알림 생성 실패\n원인: ${reason}`;
  }

  return `[서울] 날씨/미세먼지 알림 실행 실패\n원인: ${reason}`;
}

export async function main(): Promise<number> {
  let telegramConfig: TelegramConfig;

  try {
    loadEnvFromDotenvFile();
    telegramConfig = getTelegramConfigFromEnv();
  } catch (error) {
    const message =
      error instanceof ConfigError
        ? `[설정 오류] ${error.message}`
        : `[설정 오류] 환경변수 확인 중 알 수 없는 오류가 발생했습니다.`;
    console.error(message);
    return 1;
  }

  try {
    const todayDate = getKstTodayDate();
    const weekend = getClosestWeekendDates(todayDate);

    const [weatherResponse, airResponse] = await Promise.all([
      fetchJson<WeatherApiResponse>(WEATHER_API_URL, "Weather API"),
      fetchJson<AirApiResponse>(AIR_API_URL, "Air API"),
    ]);

    const weatherByDate = mapWeatherDailyByDate(weatherResponse);
    const airByDate = aggregateAirQualityByDate(airResponse);

    const message = buildReportMessage({
      todayDate,
      weekend,
      weatherByDate,
      airByDate,
    });

    console.log(message);
    await sendTelegramMessage(telegramConfig, message);
    return 0;
  } catch (error) {
    const failureMessage = buildFailureMessage(error);
    console.error(failureMessage);

    try {
      await sendTelegramMessage(telegramConfig, failureMessage);
    } catch (telegramError) {
      console.error(`[텔레그램 전송 실패] ${errorMessage(telegramError)}`);
    }

    return 1;
  }
}

if (require.main === module) {
  void main().then((exitCode) => {
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  });
}
