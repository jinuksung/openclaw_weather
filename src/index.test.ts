import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  aggregateAirQualityByDate,
  buildReportMessage,
  getClosestWeekendDates,
  loadEnvFromDotenvFile,
  type AirPeriodSummaryByDate,
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

  const message = buildReportMessage({
    todayDate: "2026-02-26",
    weekend: { saturday: "2026-02-28", sunday: "2026-03-01" },
    weatherByDate: {
      "2026-02-26": { min: 2, max: 9.04 },
      "2026-02-28": { min: 1.05, max: 8 },
      "2026-03-01": { min: 0, max: 7 },
    },
    airByDate: air,
  });

  assert.match(message, /\[서울\] 오늘\(2026-02-26\)/);
  assert.match(message, /🌡️ 최저\/최고: 2°C \/ 9°C/);
  assert.match(message, /😷 미세먼지 PM10 오전\/오후: 35 \/ 42\.1 µg\/m³/);
  assert.match(message, /🫁 초미세먼지 PM2\.5 오전\/오후: 데이터없음 \/ 24 µg\/m³/);
  assert.match(message, /토\(2026-02-28\) 🌡️ 1\.1°C \/ 8°C/);
  assert.match(message, /😷 PM10 오전\/오후: 30 \/ 40\.4/);
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
