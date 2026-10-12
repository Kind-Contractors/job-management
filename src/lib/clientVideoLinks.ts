// Gets everything the client PDF needs for its videos at the moment a PDF is delivered (downloaded or emailed): one secure watch link per
// included video and, where there is one, the video's thumbnail as a small image. Nothing here is stored; the links are re-used by the
// server so the same video always gets the same link (see docs/client-video-links.md).
//
// Rules this enforces on the manager's side (the server enforces them again - this is the safety net, not the authority):
//   * no included videos -> no request at all, so a photo-only report behaves exactly as it did before videos existed;
//   * an included video the server did not return a link for (it was removed, un-shared, or the report changed since the page loaded) ->
//     delivery STOPS with a clear message rather than sending a PDF that silently lacks a video the preview shows;
//   * a missing or unreadable thumbnail is NOT a failure: that video is drawn with a plain placeholder, still with a working link.
import type { ClientReportModel } from './clientReportModel';
import type { PdfImage } from './pdfImage';
import type { VideoPhase } from './reportVideoRules';

export interface PreparedReportVideo {
  id: string;
  phase: VideoPhase;
  /** m:ss, or '' when the length is unknown. */
  durationLabel: string;
  /** The secure watch link. Goes into the PDF only. */
  url: string;
  /** The poster image, or null (drawn as a placeholder). */
  thumbnail: PdfImage | null;
}

export interface PreparedReportVideos {
  videos: PreparedReportVideo[];
  /** How many videos are drawn without a thumbnail. */
  thumbnailsMissing: number;
}

export const NO_VIDEOS: PreparedReportVideos = { videos: [], thumbnailsMissing: 0 };

export class ClientVideoLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientVideoLinkError';
  }
}

export interface PrepareVideosDeps {
  /** videoId -> secure watch URL for every shareable video of the report. */
  requestLinks: () => Promise<Record<string, string>>;
  /** videoId -> fresh signed thumbnail URL ('' / missing when there is none). */
  signThumbnails: () => Promise<Record<string, string>>;
  /** Fetches and shrinks one image for the PDF; throws when it cannot. */
  prepareImage: (url: string) => Promise<PdfImage>;
}

export async function prepareClientReportVideos(model: ClientReportModel, deps: PrepareVideosDeps): Promise<PreparedReportVideos> {
  if (model.videos.length === 0) return NO_VIDEOS;

  let links: Record<string, string>;
  try {
    links = await deps.requestLinks();
  } catch {
    throw new ClientVideoLinkError('The video links could not be created, so nothing was sent or downloaded. Please try again.');
  }
  if (model.videos.some((v) => !links[v.id])) {
    throw new ClientVideoLinkError(
      'A video in this report can no longer be shared (it may have been removed, or the report changed). Reload the report and check the videos, then try again. Nothing was sent or downloaded.',
    );
  }

  // Thumbnails are best-effort: one broken file never blocks the report.
  let thumbnailUrls: Record<string, string> = {};
  try {
    thumbnailUrls = await deps.signThumbnails();
  } catch {
    thumbnailUrls = {};
  }

  let thumbnailsMissing = 0;
  const videos: PreparedReportVideo[] = [];
  for (const v of model.videos) {
    let thumbnail: PdfImage | null = null;
    const thumbUrl = thumbnailUrls[v.id];
    if (thumbUrl) {
      try {
        thumbnail = await deps.prepareImage(thumbUrl);
      } catch {
        thumbnail = null;
      }
    }
    if (!thumbnail) thumbnailsMissing += 1;
    videos.push({ id: v.id, phase: v.phase, durationLabel: v.durationLabel, url: links[v.id], thumbnail });
  }
  return { videos, thumbnailsMissing };
}
