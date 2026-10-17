export type MusePhotonTransportName = "photon2" | "spectrum";

export function selectMusePhotonTransport(
  value: string | undefined,
): MusePhotonTransportName {
  const selected = value?.trim().toLowerCase() || "photon2";
  if (selected === "photon2" || selected === "spectrum") return selected;
  throw new Error(
    `Unsupported MUSE_PHOTON_TRANSPORT "${selected}". Choose "photon2" or "spectrum".`,
  );
}
