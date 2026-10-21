export type MuseSpectrumPlatformName = "imessage" | "whatsapp_business";

export function selectMuseSpectrumPlatform(
  value: string | undefined,
): MuseSpectrumPlatformName {
  const selected = value?.trim().toLowerCase() || "imessage";
  if (selected === "imessage" || selected === "whatsapp_business") {
    return selected;
  }
  throw new Error(
    `Unsupported MUSE_SPECTRUM_PLATFORM "${selected}". Choose "imessage" or "whatsapp_business".`,
  );
}
