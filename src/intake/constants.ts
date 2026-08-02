export interface ArchiveLimits {
  maximumArchiveBytes: number;
  maximumEntries: number;
  maximumEntryUncompressedBytes: number;
  maximumTotalUncompressedBytes: number;
  maximumPathLength: number;
  maximumPathSegmentLength: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maximumArchiveBytes: 50 * 1024 * 1024,
  maximumEntries: 256,
  maximumEntryUncompressedBytes: 20 * 1024 * 1024,
  maximumTotalUncompressedBytes: 100 * 1024 * 1024,
  maximumPathLength: 240,
  maximumPathSegmentLength: 100,
};
