import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  aggregateAirQualityByDate,
  aggregateWeatherPeriodsByDate,
  buildReportMessage,
  getClosestWeekendDates,
  loadEnvFromDotenvFile,
  type AirPeriodSummaryByDate,
  type WeatherPeriodByDate,
} from "./index";

test("getClosestWeekendDates returns upcoming Saturday/Sunday in KST date space", () => {
  assert.deepEqual(getClosestWeekendDates("2026-02-23"), {
    saturday: "2026-02-28",
    sunday: "2026-03-01",
  });

  assert.deepEqual(getClosestWeekendDates("2026-02-28"), {
    saturday: "2026-02-28",
    sunday: "2026-03-01",
  });

  assert.deepEqual(getClosestWeekendDates("2026-03-01"), {
    saturday: "2026-03-07",
    sunday: "2026-03-08",
  });
});

test("aggregateAirQualityByDate computes morning/afternoon averages and ignores nulls", () => {
  const result = aggregateAirQualityByDate({
    hourly: {
      time: [
        "2026-02-26T06:00",
        "2026-02-26T09:00",
        "2026-02-26T12:00",
        "2026-02-26T15:00",
        "2026-02-26T20:00",
        "2026-02-27T07:00",
      ],
      pm10: [30, 40, 50, null, 80, null],
      pm2_5: [15, 25, null, 35, 45, null],
    },
  });

  assert.deepEqual(result["2026-02-26"], {
    pm10: { morning: 35, afternoon: 50 },
    pm2_5: { morning: 20, afternoon: 35 },
  });

  assert.deepEqual(result["2026-02-27"], {
    pm10: { morning: null, afternoon: null },
    pm2_5: { morning: null, afternoon: null },
  });
});

test("aggregateWeatherPeriodsByDate computes morning/afternoon temperature and weather-code representative", () => {
  const result = aggregateWeatherPeriodsByDate({
    hourly: {
      time: [
        "2026-02-26T06:00",
        "2026-02-26T09:00",
        "2026-02-26T12:00",
        "2026-02-26T15:00",
        "2026-02-26T20:00",
        "2026-02-27T07:00",
      ],
      temperature_2m: [-2, 0, 8, 10, 2, null],
      weather_code: [0, 1, 3, 61, 0, null],
    },
  });

  assert.deepEqual(result["2026-02-26"], {
    temperature: { morning: -1, afternoon: 9 },
    weatherCode: { morning: 0, afternoon: 3 },
  });

  assert.deepEqual(result["2026-02-27"], {
    temperature: { morning: null, afternoon: null },
    weatherCode: { morning: null, afternoon: null },
  });
});

test("buildReportMessage formats missing values and rounds to 0-1 decimal places", () => {
  const air: AirPeriodSummaryByDate = {
    "2026-02-26": {
      pm10: { morning: 35.04, afternoon: 42.06 },
      pm2_5: { morning: null, afternoon: 24.04 },
    },
    "2026-02-28": {
      pm10: { morning: 30, afternoon: 40.44 },
      pm2_5: { morning: 15.05, afternoon: 22 },
    },
    "2026-03-01": {
      pm10: { morning: null, afternoon: null },
      pm2_5: { morning: 14, afternoon: 20 },
    },
  };

  const weatherPeriods: WeatherPeriodByDate = {
    "2026-02-26": {
      temperature: { morning: -1.2, afternoon: 10.1 },
      weatherCode: { morning: 0, afternoon: 3 },
    },
    "2026-02-28": {
      temperature: { morning: 2.1, afternoon: 8.9 },
      weatherCode: { morning: 45, afternoon: 61 },
    },
    "2026-03-01": {
      temperature: { morning: null, afternoon: 18.2 },
      weatherCode: { morning: null, afternoon: 95 },
    },
  };

  const message = buildReportMessage({
    todayDate: "2026-02-26",
    weekend: { saturday: "2026-02-28", sunday: "2026-03-01" },
    weatherByDate: {
      "2026-02-26": { min: 2, max: 9.04 },
      "2026-02-28": { min: 1.05, max: 8 },
      "2026-03-01": { min: 0, max: 7 },
    },
    weatherPeriodsByDate: weatherPeriods,
    airByDate: air,
  });

  assert.match(message, /\[서울\] 오늘\(2026-02-26\)/);
  assert.match(message, /🌡️ 최저\/최고: 2°C \/ 9°C/);
  assert.match(message, /🌤️ 날씨 오전\/오후: 추움·맑음 \/ 쌀쌀함·흐림/);
  assert.match(message, /😷 미세먼지 PM10 오전\/오후: 35\(보통\) \/ 42\.1\(보통\) µg\/m³/);
  assert.match(message, /🫁 초미세먼지 PM2\.5 오전\/오후: 데이터없음 \/ 24\(보통\) µg\/m³/);
  assert.match(message, /토\(2026-02-28\) 🌡️ 1\.1°C \/ 8°C/);
  assert.match(message, /날씨 오전\/오후: 추움·안개 \/ 쌀쌀함·비/);
  assert.match(message, /😷 PM10 오전\/오후: 30\(좋음\) \/ 40\.4\(보통\)/);
  assert.match(message, /일\(2026-03-01\).*날씨 오전\/오후: 데이터없음 \/ 선선함·뇌우/s);
  assert.match(message, /일\(2026-03-01\).*PM10 오전\/오후: 데이터없음 \/ 데이터없음/s);
});

test("loadEnvFromDotenvFile loads TELEGRAM env values from a .env file", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "weather-dotenv-test-"));
  const envPath = join(tempDir, ".env");
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousChatId = process.env.TELEGRAM_CHAT_ID;

  try {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;

    writeFileSync(
      envPath,
      'TELEGRAM_BOT_TOKEN="test-token"\nTELEGRAM_CHAT_ID="123456"\n',
      "utf8",
    );

    loadEnvFromDotenvFile(envPath);

    assert.equal(process.env.TELEGRAM_BOT_TOKEN, "test-token");
    assert.equal(process.env.TELEGRAM_CHAT_ID, "123456");
  } finally {
    if (previousToken === undefined) {
      delete process.env.TELEGRAM_BOT_TOKEN;
    } else {
      process.env.TELEGRAM_BOT_TOKEN = previousToken;
    }

    if (previousChatId === undefined) {
      delete process.env.TELEGRAM_CHAT_ID;
    } else {
      process.env.TELEGRAM_CHAT_ID = previousChatId;
    }

    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("buildReportMessage uses naver-style dust grade ranges", () => {
  const message = buildReportMessage({
    todayDate: "2026-02-26",
    weekend: { saturday: "2026-02-28", sunday: "2026-03-01" },
    weatherByDate: {
      "2026-02-26": { min: 2, max: 9 },
      "2026-02-28": { min: 1, max: 8 },
      "2026-03-01": { min: 0, max: 7 },
    },
    weatherPeriodsByDate: {
      "2026-02-26": {
        temperature: { morning: 2, afternoon: 9 },
        weatherCode: { morning: 1, afternoon: 1 },
      },
      "2026-02-28": {
        temperature: { morning: 2, afternoon: 9 },
        weatherCode: { morning: 1, afternoon: 1 },
      },
      "2026-03-01": {
        temperature: { morning: 2, afternoon: 9 },
        weatherCode: { morning: 1, afternoon: 1 },
      },
    },
    airByDate: {
      "2026-02-26": {
        pm10: { morning: 8, afternoon: 16 },
        pm2_5: { morning: 7, afternoon: 20 },
      },
      "2026-02-28": {
        pm10: { morning: 8, afternoon: 16 },
        pm2_5: { morning: 7, afternoon: 20 },
      },
      "2026-03-01": {
        pm10: { morning: 8, afternoon: 16 },
        pm2_5: { morning: 7, afternoon: 20 },
      },
    },
  });

  assert.match(message, /PM10 오전\/오후: 8\(좋음\) \/ 16\(좋음\)/);
  assert.match(message, /PM2\.5 오전\/오후: 7\(좋음\) \/ 20\(보통\)/);
  assert.doesNotMatch(message, /매우좋음/);
});
