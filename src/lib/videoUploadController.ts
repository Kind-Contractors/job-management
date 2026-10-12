// The upload flow for ONE report's videos, without any React: pick a file -> check it -> read its length and poster -> upload ->
// save. The review screen drives this and only renders what it reports, which keeps the rules that matter - never two uploads
// at once, never starting on a Completed report, retry only when it can help, cancel really cancels - in one place that can be
// tested directly.
import {
  COMPLETED_VIDEOS_MESSAGE,
  checkVideoDuration,
  checkVideoSelection,
  countVideos,
  explainVideoError,
  type VideoPhase,
} from './reportVideoRules';
import { UploadCancelledError } from './reportVideoUpload';
import type { VideoMetadata } from './videoMetadata';
import type { ReportVideo, UploadReportVideoInput } from '../repository/reportVideosRepository';

export type UploadStage = 'reading' | 'uploading' | 'saving' | 'failed';

export interface UploadState {
  phase: VideoPhase;
  fileName: string;
  fileSize: number;
  stage: UploadStage;
  /** 0..1, while uploading */
  progress: number;
  error?: string;
  /** On a failure: false when trying the same file again cannot help (for example it is too long). */
  retryable?: boolean;
}

export interface VideoUploadControllerOptions {
  visitId: string;
  /** Read at the moment a file is picked, so it is always the current list. */
  context: () => { videos: { phase: VideoPhase }[]; completed: boolean };
  readMetadata: (file: File) => Promise<VideoMetadata>;
  upload: (input: UploadReportVideoInput) => Promise<ReportVideo>;
  onState: (state: UploadState | null) => void;
  onPickError: (phase: VideoPhase, message: string | null) => void;
  /** Called once the video has been uploaded AND saved. */
  onUploaded: (video: ReportVideo) => void;
}

export class VideoUploadController {
  private running = false;
  private abort: AbortController | null = null;
  private last: { file: File; phase: VideoPhase } | null = null;

  constructor(private readonly o: VideoUploadControllerOptions) {}

  /** True from the moment a file is accepted until the upload has finished, failed or been cancelled. */
  get busy(): boolean {
    return this.running;
  }

  async start(file: File, phase: VideoPhase): Promise<void> {
    // Set before anything is awaited: a second click or a second file picked straight away is ignored, never queued or doubled.
    if (this.running) return;
    const { videos, completed } = this.o.context();
    if (completed) {
      this.o.onPickError(phase, COMPLETED_VIDEOS_MESSAGE);
      return;
    }
    const check = checkVideoSelection(file, phase, countVideos(videos, phase));
    if (!check.ok) {
      this.o.onPickError(phase, check.message);
      return;
    }
    this.running = true;
    this.o.onPickError(phase, null);
    this.last = { file, phase };
    const controller = new AbortController();
    this.abort = controller;
    const base = { phase, fileName: file.name, fileSize: file.size, progress: 0 };
    this.o.onState({ ...base, stage: 'reading' });
    try {
      const meta = await this.o.readMetadata(file);
      if (controller.signal.aborted) {
        this.o.onState(null);
        return;
      }
      const tooLong = checkVideoDuration(meta.durationSeconds);
      if (tooLong) {
        this.o.onState({ ...base, stage: 'failed', error: tooLong, retryable: false });
        return;
      }
      this.o.onState({ ...base, stage: 'uploading' });
      const video = await this.o.upload({
        visitId: this.o.visitId,
        phase,
        file,
        mime: check.mime,
        ext: check.ext,
        durationSeconds: meta.durationSeconds,
        thumbnail: meta.thumbnail,
        signal: controller.signal,
        onProgress: (sent, total) => this.o.onState({ ...base, stage: 'uploading', progress: total > 0 ? sent / total : 0 }),
        onSaving: () => this.o.onState({ ...base, stage: 'saving', progress: 1 }),
      });
      this.last = null;
      this.o.onState(null);
      this.o.onUploaded(video);
    } catch (e) {
      if (e instanceof UploadCancelledError || controller.signal.aborted) {
        this.o.onState(null);
      } else {
        this.o.onState({ ...base, stage: 'failed', error: explainVideoError(e), retryable: true });
      }
    } finally {
      this.running = false;
      this.abort = null;
    }
  }

  /** Stops the upload in progress (the files it had sent are discarded). No effect when nothing is uploading. */
  cancel(): void {
    this.abort?.abort();
  }

  /** Tries the last picked file again, from the start, with fresh file names. No effect while an upload is running. */
  retry(): Promise<void> {
    const last = this.last;
    if (!last || this.running) return Promise.resolve();
    return this.start(last.file, last.phase);
  }

  /** Clears a failure message. */
  dismiss(): void {
    if (!this.running) {
      this.last = null;
      this.o.onState(null);
    }
  }
}
