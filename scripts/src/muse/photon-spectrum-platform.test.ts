import assert from "node:assert/strict";
import test from "node:test";
import { selectMuseSpectrumPlatform } from "./photon-spectrum-platform.js";

test("Spectrum platform defaults to iMessage", () => {
  assert.equal(selectMuseSpectrumPlatform(undefined), "imessage");
  assert.equal(selectMuseSpectrumPlatform("  "), "imessage");
});

test("Spectrum platform accepts iMessage and WhatsApp Business", () => {
  assert.equal(selectMuseSpectrumPlatform("imessage"), "imessage");
  assert.equal(
    selectMuseSpectrumPlatform(" WHATSAPP_BUSINESS "),
    "whatsapp_business",
  );
});

test("Spectrum platform rejects unknown values", () => {
  assert.throws(
    () => selectMuseSpectrumPlatform("telegram"),
    /Choose "imessage" or "whatsapp_business"/,
  );
});
