import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  composeUiPreviewDocument,
  UI_PREVIEW_CAPABILITY_GUARD_SCRIPT,
} from './uiPreviewDocumentService.js';
import { createUiPreviewArtifactStore, type UiPreviewArtifactStore } from './uiPreviewArtifactStore.js';

export interface UiPreviewViewport {
  width: number;
  height: number;
  deviceScaleFactor?: number;
}

export interface UiPreviewCaptureInput {
  title?: string | null;
  html: string;
  css?: string | null;
  js?: string | null;
  viewport: UiPreviewViewport;
}

export interface UiPreviewCaptureResult {
  artifactId: string;
  absolutePath: string;
  png: Buffer;
  viewport: Required<UiPreviewViewport>;
}

export type UiPreviewScreenshotErrorCode =
  | 'UI_PREVIEW_RENDERER_UNAVAILABLE'
  | 'UI_PREVIEW_CAPTURE_TIMEOUT'
  | 'UI_PREVIEW_CAPTURE_FAILED';

export class UiPreviewScreenshotError extends Error {
  readonly code: UiPreviewScreenshotErrorCode;
  readonly cause?: unknown;

  constructor(code: UiPreviewScreenshotErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'UiPreviewScreenshotError';
    this.code = code;
    this.cause = cause;
  }
}

type BrowserLike = {
  isConnected?: () => boolean;
  on?: (event: string, handler: (...args: any[]) => void) => void;
  newContext(options?: any): Promise<any>;
  close?: () => Promise<void>;
};

type BrowserFactory = () => Promise<BrowserLike>;

type SystemBrowserCapture = (
  input: UiPreviewCaptureInput,
  viewport: Required<UiPreviewViewport>,
  timeoutMs: number,
) => Promise<Buffer>;

function isMissingExecutable(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function isProcessTimeout(error: unknown) {
  const candidate = error as (Error & { killed?: boolean; code?: string }) | undefined;
  return candidate?.killed === true || candidate?.code === 'ETIMEDOUT' || /timed out|timeout/i.test(toErrorMessage(error));
}

function browserExecutableCandidates() {
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles;
    const programFilesX86 = process.env['ProgramFiles(x86)'];
    const localAppData = process.env.LOCALAPPDATA;
    if (programFilesX86) candidates.push(path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    if (programFiles) candidates.push(path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    if (localAppData) candidates.push(path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    if (programFiles) candidates.push(path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    if (programFilesX86) candidates.push(path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    if (localAppData) candidates.push(path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    candidates.push('msedge.exe', 'chrome.exe', 'chromium.exe');
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
    if (process.env.HOME) {
      candidates.push(
        path.join(process.env.HOME, 'Applications', 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'),
        path.join(process.env.HOME, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
      );
    }
    candidates.push('microsoft-edge', 'google-chrome', 'chromium');
  } else {
    candidates.push('google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge');
  }
  return [...new Set(candidates)];
}

function execFileBounded(file: string, args: string[], timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function isPngBuffer(value: Buffer) {
  return value.length >= 8 && value.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

async function defaultSystemBrowserCapture(
  input: UiPreviewCaptureInput,
  viewport: Required<UiPreviewViewport>,
  timeoutMs: number,
): Promise<Buffer> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'devflow-ui-preview-browser-'));
  const htmlPath = path.join(tempRoot, 'preview.html');
  const screenshotPath = path.join(tempRoot, 'preview.png');
  const profileDir = path.join(tempRoot, 'profile');
  try {
    const document = composeUiPreviewDocument(input);
    await fs.writeFile(htmlPath, document.html, 'utf8');
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-sync',
      '--metrics-recording-only',
      '--mute-audio',
      `--user-data-dir=${profileDir}`,
      `--window-size=${viewport.width},${viewport.height}`,
      `--force-device-scale-factor=${viewport.deviceScaleFactor}`,
      `--screenshot=${screenshotPath}`,
      pathToFileURL(htmlPath).href,
    ];
    let lastError: unknown;
    let executableReached = false;
    for (const executable of browserExecutableCandidates()) {
      try {
        await execFileBounded(executable, args, timeoutMs);
        executableReached = true;
        const png = await fs.readFile(screenshotPath);
        if (!isPngBuffer(png)) throw new Error(`System browser '${executable}' did not produce a valid PNG screenshot.`);
        return png;
      } catch (error) {
        if (isProcessTimeout(error)) {
          throw new UiPreviewScreenshotError(
            'UI_PREVIEW_CAPTURE_TIMEOUT',
            `System browser UI preview capture exceeded the ${timeoutMs}ms safety timeout.`,
            error,
          );
        }
        if (!isMissingExecutable(error)) executableReached = true;
        lastError = error;
        await fs.rm(screenshotPath, { force: true }).catch(() => {});
      }
    }
    if (!executableReached) {
      throw new UiPreviewScreenshotError(
        'UI_PREVIEW_RENDERER_UNAVAILABLE',
        'Playwright is unavailable and no compatible system Edge/Chrome/Chromium renderer was found.',
        lastError,
      );
    }
    throw new UiPreviewScreenshotError(
      'UI_PREVIEW_CAPTURE_FAILED',
      `System browser UI preview capture failed: ${toErrorMessage(lastError)}`,
      lastError,
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

const DEFAULT_CAPTURE_TIMEOUT_MS = 5_000;
const MAX_CAPTURE_TIMEOUT_MS = 5_000;
const MIN_CAPTURE_TIMEOUT_MS = 25;

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? 'Unknown UI preview renderer error.');
}

function isRendererUnavailableError(error: unknown) {
  const message = toErrorMessage(error);
  return /executable.*(?:does not exist|doesn't exist|not found)|browser executable|cannot find package ['"]playwright|cannot find module ['"]playwright|playwright.*not found/i.test(message);
}

function isBrowserCrashError(error: unknown) {
  const message = toErrorMessage(error);
  return /target .*closed|browser.*closed|browser.*disconnected|has been closed|connection closed|not connected/i.test(message);
}

function normalizeViewport(viewport: UiPreviewViewport): Required<UiPreviewViewport> {
  const width = Number(viewport.width);
  const height = Number(viewport.height);
  const deviceScaleFactor = Number(viewport.deviceScaleFactor ?? 1);
  if (!Number.isInteger(width) || width <= 0 || width > 10_000) throw new Error('Invalid UI preview viewport width.');
  if (!Number.isInteger(height) || height <= 0 || height > 10_000) throw new Error('Invalid UI preview viewport height.');
  if (!Number.isFinite(deviceScaleFactor) || deviceScaleFactor <= 0 || deviceScaleFactor > 4) {
    throw new Error('Invalid UI preview deviceScaleFactor.');
  }
  return { width, height, deviceScaleFactor };
}

function normalizeCaptureTimeout(value: number | undefined) {
  if (!Number.isFinite(value)) return DEFAULT_CAPTURE_TIMEOUT_MS;
  return Math.min(MAX_CAPTURE_TIMEOUT_MS, Math.max(MIN_CAPTURE_TIMEOUT_MS, Math.floor(value!)));
}

async function defaultBrowserFactory(timeoutMs: number): Promise<BrowserLike> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
  const playwright = await dynamicImport('playwright');
  return playwright.chromium.launch({ headless: true, timeout: timeoutMs });
}

export function isAllowedPreviewRequestUrl(value: string) {
  const normalized = String(value || '').trim();
  if (/^about:blank(?:[#?].*)?$/i.test(normalized)) return true;
  if (/^data:/i.test(normalized)) return true;
  if (/^blob:/i.test(normalized)) return true;
  return false;
}

function shouldAllowPreviewHttpRequest(request: any) {
  if (request?.isNavigationRequest?.() === true) return false;
  return isAllowedPreviewRequestUrl(request?.url?.() ?? '');
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new UiPreviewScreenshotError(
          'UI_PREVIEW_CAPTURE_TIMEOUT',
          `UI preview capture exceeded the ${timeoutMs}ms safety timeout.`,
        )), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function ignoreRejection(value: unknown) {
  if (value && typeof (value as PromiseLike<unknown>).then === 'function') {
    void Promise.resolve(value).catch(() => {});
  }
}

export function createUiPreviewScreenshotService(options: {
  artifactStore?: UiPreviewArtifactStore;
  browserFactory?: BrowserFactory;
  systemBrowserCapture?: SystemBrowserCapture | null;
  captureTimeoutMs?: number;
} = {}) {
  const artifactStore = options.artifactStore ?? createUiPreviewArtifactStore();
  const captureTimeoutMs = normalizeCaptureTimeout(options.captureTimeoutMs);
  const browserFactory = options.browserFactory ?? (() => defaultBrowserFactory(captureTimeoutMs));
  const systemBrowserCapture = options.systemBrowserCapture === undefined ? defaultSystemBrowserCapture : options.systemBrowserCapture;
  let browserPromise: Promise<BrowserLike> | null = null;
  let activeBrowser: BrowserLike | null = null;

  function invalidateBrowser(browser?: BrowserLike | null) {
    if (browser && activeBrowser && browser !== activeBrowser) return;
    browserPromise = null;
    activeBrowser = null;
  }

  async function getBrowser() {
    if (!browserPromise) {
      browserPromise = Promise.resolve()
        .then(browserFactory)
        .then((browser) => {
          if (browser.isConnected?.() === false) {
            throw new Error('Browser is not connected.');
          }
          activeBrowser = browser;
          browser.on?.('disconnected', () => invalidateBrowser(browser));
          return browser;
        })
        .catch((error) => {
          invalidateBrowser();
          if (isRendererUnavailableError(error)) {
            throw new UiPreviewScreenshotError(
              'UI_PREVIEW_RENDERER_UNAVAILABLE',
              'Playwright Chromium is unavailable. Install dependencies, then run `npx playwright install chromium`.',
              error,
            );
          }
          throw error;
        });
    }
    return browserPromise;
  }

  async function captureOnce(input: UiPreviewCaptureInput): Promise<UiPreviewCaptureResult> {
    const viewport = normalizeViewport(input.viewport);
    const browser = await getBrowser();
    let context: any;
    try {
      context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: viewport.deviceScaleFactor,
        javaScriptEnabled: true,
        serviceWorkers: 'block',
        acceptDownloads: false,
      });

      if (typeof context.addInitScript !== 'function' || typeof context.route !== 'function' || typeof context.routeWebSocket !== 'function') {
        throw new Error('Playwright context is missing required UI preview sandbox routing capabilities.');
      }

      await context.addInitScript(UI_PREVIEW_CAPABILITY_GUARD_SCRIPT);
      await context.route('**/*', async (route: any) => {
        if (shouldAllowPreviewHttpRequest(route.request?.())) {
          await route.continue?.();
        } else {
          await route.abort?.('blockedbyclient');
        }
      });
      await context.routeWebSocket('**/*', async (webSocket: any) => {
        await webSocket.close?.({ code: 1008, reason: 'Blocked by UI preview sandbox' });
      });

      const page = await context.newPage();
      context.on?.('page', (candidate: any) => {
        if (candidate !== page) ignoreRejection(candidate.close?.());
      });
      page.on?.('popup', (popup: any) => { ignoreRejection(popup.close?.()); });
      page.on?.('dialog', (dialog: any) => { ignoreRejection(dialog.dismiss?.()); });
      page.on?.('download', (download: any) => { ignoreRejection(download.cancel?.()); });

      const document = composeUiPreviewDocument(input);
      const png = Buffer.from(await withTimeout((async () => {
        await page.setContent(document.html, { waitUntil: 'domcontentloaded', timeout: captureTimeoutMs });
        return page.screenshot({
          type: 'png',
          fullPage: false,
          animations: 'disabled',
          caret: 'hide',
          timeout: captureTimeoutMs,
        });
      })(), captureTimeoutMs));

      const saved = await artifactStore.writePng(png);
      return {
        artifactId: saved.artifactId,
        absolutePath: saved.absolutePath,
        png,
        viewport,
      };
    } finally {
      try {
        await context?.close?.();
      } catch {}
    }
  }

  async function captureWithSystemBrowser(input: UiPreviewCaptureInput): Promise<UiPreviewCaptureResult> {
    if (!systemBrowserCapture) {
      throw new UiPreviewScreenshotError(
        'UI_PREVIEW_RENDERER_UNAVAILABLE',
        'Playwright Chromium is unavailable. Install dependencies, then run `npx playwright install chromium`.',
      );
    }
    const viewport = normalizeViewport(input.viewport);
    const png = Buffer.from(await systemBrowserCapture(input, viewport, captureTimeoutMs));
    if (!isPngBuffer(png)) {
      throw new UiPreviewScreenshotError('UI_PREVIEW_CAPTURE_FAILED', 'System browser renderer returned an invalid PNG screenshot.');
    }
    const saved = await artifactStore.writePng(png);
    return {
      artifactId: saved.artifactId,
      absolutePath: saved.absolutePath,
      png,
      viewport,
    };
  }

  async function capture(input: UiPreviewCaptureInput): Promise<UiPreviewCaptureResult> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await captureOnce(input);
      } catch (error) {
        lastError = error;
        if (error instanceof UiPreviewScreenshotError) {
          if (error.code === 'UI_PREVIEW_RENDERER_UNAVAILABLE') {
            invalidateBrowser();
            return captureWithSystemBrowser(input);
          }
          throw error;
        }
        if (isRendererUnavailableError(error)) {
          invalidateBrowser();
          return captureWithSystemBrowser(input);
        }
        if (attempt === 0 && isBrowserCrashError(error)) {
          const previousBrowser = activeBrowser;
          invalidateBrowser(previousBrowser);
          try {
            await previousBrowser?.close?.();
          } catch {}
          continue;
        }
        break;
      }
    }
    throw new UiPreviewScreenshotError(
      'UI_PREVIEW_CAPTURE_FAILED',
      `UI preview screenshot capture failed: ${toErrorMessage(lastError)}`,
      lastError,
    );
  }

  async function close() {
    let browser: BrowserLike | null = activeBrowser;
    if (!browser && browserPromise) {
      browser = await browserPromise.catch(() => null);
    }
    invalidateBrowser(browser);
    try {
      await browser?.close?.();
    } catch {}
  }

  return { capture, close, artifactStore };
}
