import { config as dotenvConfig } from "dotenv";

const SEOUL_LATITUDE = 37.5665;
const SEOUL_LONGITUDE = 126.9780;
const SEOUL_TIMEZONE = "Asia/Seoul";

const WEATHER_API_URL =
  `https://api.open-meteo.com/v1/forecast?latitude=${SEOUL_LATITUDE}` +
  `&longitude=${SEOUL_LONGITUDE}` +
  `&daily=temperature_2m_max,temperature_2m_min` +
  `&hourly=temperature_2m,weather_code` +
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

export interface WeatherDayPeriodSummary {
  temperature: PeriodAverage;
  weatherCode: PeriodAverage;
}

export type WeatherPeriodByDate = Record<string, WeatherDayPeriodSummary>;

export interface WeekendDates {
  saturday: string;
  sunday: string;
}

export interface BuildReportMessageInput {
  todayDate: string;
  weekend: WeekendDates;
  weatherByDate: WeatherByDate;
  weatherPeriodsByDate: WeatherPeriodByDate;
  airByDate: AirPeriodSummaryByDate;
}

interface WeatherApiResponse {
  daily?: {
    time?: string[];
    temperature_2m_min?: Array<number | null>;
    temperature_2m_max?: Array<number | null>;
  };
  hourly?: {
    time?: string[];
    temperature_2m?: Array<number | null>;
    weather_code?: Array<number | null>;
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

function emptyWeatherDayPeriodSummary(): WeatherDayPeriodSummary {
  return {
    temperature: { morning: null, afternoon: null },
    weatherCode: { morning: null, afternoon: null },
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

function representativeWeatherCode(values: number[]): NullableNumber {
  if (values.length === 0) {
    return null;
  }

  const counts = new Map<number, { count: number; firstIndex: number }>();
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    const previous = counts.get(value);
    if (previous) {
      previous.count += 1;
      continue;
    }
    counts.set(value, { count: 1, firstIndex: i });
  }

  let bestValue = values[0];
  let bestCount = -1;
  let bestIndex = Number.MAX_SAFE_INTEGER;

  for (const [value, entry] of counts.entries()) {
    if (
      entry.count > bestCount ||
      (entry.count === bestCount && entry.firstIndex < bestIndex)
    ) {
      bestValue = value;
      bestCount = entry.count;
      bestIndex = entry.firstIndex;
    }
  }

  return bestValue;
}

export function aggregateWeatherPeriodsByDate(response: WeatherApiResponse): WeatherPeriodByDate {
  const time = response.hourly?.time;
  const temperature = response.hourly?.temperature_2m;
  const weatherCode = response.hourly?.weather_code;

  if (!Array.isArray(time) || !Array.isArray(temperature) || !Array.isArray(weatherCode)) {
    throw new Error(
      "Weather API 응답에 hourly.time/temperature_2m/weather_code 배열이 없습니다.",
    );
  }

  if (time.length !== temperature.length || time.length !== weatherCode.length) {
    throw new Error("Weather API hourly 응답 배열 길이가 일치하지 않습니다.");
  }

  type Bucket = {
    temperature: { morning: number[]; afternoon: number[] };
    weatherCode: { morning: number[]; afternoon: number[] };
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
        temperature: { morning: [], afternoon: [] },
        weatherCode: { morning: [], afternoon: [] },
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

    const tempValue = temperature[i];
    const codeValue = weatherCode[i];

    if (isFiniteNumber(tempValue)) {
      buckets[date].temperature[period].push(tempValue);
    }
    if (isFiniteNumber(codeValue)) {
      buckets[date].weatherCode[period].push(codeValue);
    }
  }

  const result: WeatherPeriodByDate = {};

  for (const [date, bucket] of Object.entries(buckets)) {
    result[date] = {
      temperature: {
        morning: average(bucket.temperature.morning),
        afternoon: average(bucket.temperature.afternoon),
      },
      weatherCode: {
        morning: representativeWeatherCode(bucket.weatherCode.morning),
        afternoon: representativeWeatherCode(bucket.weatherCode.afternoon),
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

function describeTemperature(value: NullableNumber): string | null {
  if (value === null) {
    return null;
  }

  if (value <= -5) return "매우추움";
  if (value <= 5) return "추움";
  if (value <= 12) return "쌀쌀함";
  if (value <= 19) return "선선함";
  if (value <= 26) return "온화함";
  if (value <= 31) return "더움";
  return "매우더움";
}

function describeWeatherCode(value: NullableNumber): string | null {
  if (value === null) {
    return null;
  }

  if (value === 0) return "맑음";
  if (value === 1 || value === 2 || value === 3) return "흐림";
  if (value === 45 || value === 48) return "안개";
  if (
    (value >= 51 && value <= 67) ||
    (value >= 80 && value <= 82)
  ) {
    return "비";
  }
  if ((value >= 71 && value <= 77) || value === 85 || value === 86) {
    return "눈";
  }
  if (value === 95 || value === 96 || value === 99) {
    return "뇌우";
  }

  return "날씨정보없음";
}

function formatWeatherLabel(temperature: NullableNumber, weatherCode: NullableNumber): string {
  const temperatureLabel = describeTemperature(temperature);
  const weatherLabel = describeWeatherCode(weatherCode);

  if (temperatureLabel && weatherLabel) {
    return `${temperatureLabel}·${weatherLabel}`;
  }
  if (temperatureLabel) {
    return temperatureLabel;
  }
  if (weatherLabel) {
    return weatherLabel;
  }
  return "데이터없음";
}

function formatWeatherPeriodPair(summary: WeatherDayPeriodSummary): string {

  const lines = [
    `- 오전: ${formatWeatherLabel(summary.temperature.morning, summary.weatherCode.morning)}`,
    `- 오후: ${formatWeatherLabel(summary.temperature.afternoon, summary.weatherCode.afternoon)}`
  ]
  return lines.join("\n");
}

function getPmGrade(kind: "pm10" | "pm2_5", value: NullableNumber): string | null {
  if (value === null) {
    return null;
  }

  if (kind === "pm10") {
    if (value <= 30) return "좋음";
    if (value <= 80) return "보통";
    if (value <= 150) return "나쁨";
    return "매우나쁨";
  }

  if (value <= 15) return "좋음";
  if (value <= 35) return "보통";
  if (value <= 75) return "나쁨";
  return "매우나쁨";
}

function formatPmValueWithGrade(kind: "pm10" | "pm2_5", value: NullableNumber): string {
  if (value === null) {
    return "데이터없음";
  }

  const grade = getPmGrade(kind, value);
  return `${grade}(${formatRoundedNumber(value)})µg/m³`;
}

function formatPmPeriodPair(
  kind: "pm10" | "pm2_5",
  period: PeriodAverage,
  includeUnit: boolean,
): string {
  const lines = [
    `- 오전: ${formatPmValueWithGrade(kind, period.morning)}`,
    `- 오후: ${formatPmValueWithGrade(kind,period.afternoon)}`
  ]
  const pair = lines.join("\n")
  return includeUnit ? `${pair} µg/m³` : pair;
}

export function buildReportMessage(input: BuildReportMessageInput): string {
  const todayWeather = input.weatherByDate[input.todayDate] ?? { min: null, max: null };
  const todayWeatherPeriod =
    input.weatherPeriodsByDate[input.todayDate] ?? emptyWeatherDayPeriodSummary();
  const todayAir = input.airByDate[input.todayDate] ?? emptyAirDaySummary();

  const saturdayWeather = input.weatherByDate[input.weekend.saturday] ?? { min: null, max: null };
  const sundayWeather = input.weatherByDate[input.weekend.sunday] ?? { min: null, max: null };
  const saturdayWeatherPeriod =
    input.weatherPeriodsByDate[input.weekend.saturday] ?? emptyWeatherDayPeriodSummary();
  const sundayWeatherPeriod =
    input.weatherPeriodsByDate[input.weekend.sunday] ?? emptyWeatherDayPeriodSummary();
  const saturdayAir = input.airByDate[input.weekend.saturday] ?? emptyAirDaySummary();
  const sundayAir = input.airByDate[input.weekend.sunday] ?? emptyAirDaySummary();

  const lines = [
    `[서울]`,
    `오늘(${input.todayDate})`,
    `🌡️ 기온`,
    `- 최저: ${formatTemperature(todayWeather.min)}`,
    `- 최고: ${formatTemperature(todayWeather.max)}`,
    `🌤️ 날씨`,
    `${formatWeatherPeriodPair(todayWeatherPeriod)}`,
    `😷 미세먼지`,
    `${formatPmPeriodPair("pm10", todayAir.pm10, false)}`,
    `🫁 초미세먼지`,
    `${formatPmPeriodPair("pm2_5", todayAir.pm2_5, false)}`,
    "",
    "[주말]",
    `토(${input.weekend.saturday})`,
    `🌡️ 기온`,
    `- 최저: ${formatTemperature(saturdayWeather.min)}`,
    `- 최고: ${formatTemperature(saturdayWeather.max)}`,
    `🌤️ 날씨`,
    `${formatWeatherPeriodPair(saturdayWeatherPeriod)}`,
    `😷 미세먼지`,
    `${formatPmPeriodPair("pm10", saturdayAir.pm10, false)}`,
    `🫁 초미세먼지`,
    `${formatPmPeriodPair("pm2_5", saturdayAir.pm2_5, false)}`,
    "",
    `일(${input.weekend.sunday})`,
    `🌡️ 기온`,
    `- 최저: ${formatTemperature(sundayWeather.min)}`,
    `- 최고: ${formatTemperature(sundayWeather.max)}`,
    `🌤️ 날씨`,
    `${formatWeatherPeriodPair(sundayWeatherPeriod)}`,
    `😷 미세먼지`,
    `${formatPmPeriodPair("pm10", sundayAir.pm10, false)}`,
    `🫁 초미세먼지`,
    `${formatPmPeriodPair("pm2_5", sundayAir.pm2_5, false)}`,
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
    const weatherPeriodsByDate = aggregateWeatherPeriodsByDate(weatherResponse);
    const airByDate = aggregateAirQualityByDate(airResponse);

    const message = buildReportMessage({
      todayDate,
      weekend,
      weatherByDate,
      weatherPeriodsByDate,
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
