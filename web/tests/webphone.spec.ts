import { chromium, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

interface User {
  extension: string;
  name: string;
  password: string;
  type?: string;
}

const usersFile = process.env.USERS_FILE ?? path.resolve(import.meta.dirname, '../../users.json');
const allUsers = (JSON.parse(readFileSync(usersFile, 'utf8')) as { users: User[] }).users;
const webrtcUsers = allUsers.filter((u) => (u.type ?? 'webrtc') === 'webrtc');
// TEST_USERS=1003,1004 picks the two accounts to sign in with (default: the first two WebRTC users).
const picked = (process.env.TEST_USERS ?? '').split(',').filter(Boolean);
const byExt = (ext: string) => allUsers.find((u) => u.extension === ext);
const [alice, bob] = (picked.length === 2 ? picked.map((ext) => byExt(ext)!) : webrtcUsers.slice(0, 2)) as [User, User];
// An extension nobody is signed in on (TEST_OFFLINE_EXT, default: the next WebRTC user).
const carol = process.env.TEST_OFFLINE_EXT
  ? byExt(process.env.TEST_OFFLINE_EXT)
  : webrtcUsers.find((u) => u !== alice && u !== bob);

const FAKE_MEDIA_ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'];

let browser: Browser;
let ownsBrowser = true;
let aliceContext: BrowserContext;
let bobContext: BrowserContext;
let alicePage: Page;
let bobPage: Page;

async function signIn(page: Page, user: User): Promise<void> {
  await page.goto('/');
  await page.locator('#login-extension').fill(user.extension);
  await page.locator('#login-password').fill(user.password);
  await page.locator('.login-form button[type="submit"]').click();
  await expect(page.locator('.status-pill')).toHaveAttribute('data-state', 'registered');
}

async function newPhone(user: User): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: test.info().project.use.baseURL });
  const baseURL = test.info().project.use.baseURL ?? 'https://localhost:8443';
  await context.grantPermissions(['camera', 'microphone'], { origin: new URL(baseURL).origin });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.error(`[${user.extension}] page error:`, error));
  if (process.env.DEBUG_CONSOLE) page.on('console', (msg) => console.log(`[${user.extension}] ${msg.type()}: ${msg.text()}`));
  await signIn(page, user);
  return { context, page };
}

function contactRow(page: Page, extension: string) {
  return page.locator(`.contact[data-extension="${extension}"]`);
}

async function dial(page: Page, number: string, video: boolean): Promise<void> {
  await page.locator('.dial-input').fill(number);
  await page.locator(video ? '.call-btn-video' : '.call-btn-audio').click();
}

async function expectMediaFlowing(page: Page, video: boolean): Promise<void> {
  const view = page.locator('.call-view');
  await expect(view).toHaveAttribute('data-status', 'active');
  await expect(view).toHaveAttribute('data-audio-rx', 'true');
  if (video) {
    await expect(view).toHaveAttribute('data-video-rx', 'true');
    await expect(view).toHaveClass(/has-remote-video/);
    const size = await page.locator('.remote-video').evaluate((el: HTMLVideoElement) => [el.videoWidth, el.videoHeight]);
    expect(size[0]).toBeGreaterThan(0);
    expect(size[1]).toBeGreaterThan(0);
  }
}

async function hangUp(page: Page): Promise<void> {
  await page.locator('.control-hangup').click();
}

async function expectIdle(page: Page): Promise<void> {
  await expect(page.locator('.call-view')).toHaveCount(0, { timeout: 15_000 });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  if (process.env.CDP_URL) {
    browser = await chromium.connectOverCDP(process.env.CDP_URL);
    ownsBrowser = false;
  } else {
    browser = await chromium.launch({ args: FAKE_MEDIA_ARGS });
  }
  ({ context: aliceContext, page: alicePage } = await newPhone(alice));
  ({ context: bobContext, page: bobPage } = await newPhone(bob));
});

test.afterAll(async () => {
  await aliceContext?.close();
  await bobContext?.close();
  if (ownsBrowser) await browser?.close();
});

test('users register and see each other online (presence)', async () => {
  await expect(contactRow(alicePage, bob.extension)).toHaveAttribute('data-presence', 'available');
  await expect(contactRow(bobPage, alice.extension)).toHaveAttribute('data-presence', 'available');
  if (carol) await expect(contactRow(alicePage, carol.extension)).toHaveAttribute('data-presence', 'offline');
});

test('video call between two browsers carries audio and video both ways', async () => {
  await contactRow(alicePage, bob.extension).locator('[data-action="video"]').click();

  const incoming = bobPage.locator('.incoming-card');
  await expect(incoming).toBeVisible();
  await expect(incoming).toContainText(alice.name);
  await expect(incoming).toContainText(/video call/i);
  await expect(contactRow(bobPage, alice.extension)).toHaveAttribute('data-presence', /busy|ringing/);
  await bobPage.locator('[data-action="answer-video"]').click();

  await expectMediaFlowing(alicePage, true);
  await expectMediaFlowing(bobPage, true);
  for (const page of [alicePage, bobPage]) {
    await expect(page.locator('.call-view')).toHaveAttribute('data-video-codec', /VP8|H264/);
    await expect(page.locator('.call-view')).toHaveAttribute('data-audio-codec', 'OPUS');
    await expect(page.locator('.local-pip')).toHaveClass(/visible/);
  }
  await expect(contactRow(alicePage, bob.extension)).toHaveAttribute('data-presence', 'busy');

  // Camera off on Bob's side: Alice stops receiving video frames, then gets them back.
  await bobPage.locator('.control', { hasText: /stop video/i }).click();
  await expect(alicePage.locator('.call-view')).toHaveAttribute('data-video-rx', 'false');
  await bobPage.locator('.control', { hasText: /start video/i }).click();
  await expect(alicePage.locator('.call-view')).toHaveAttribute('data-video-rx', 'true');

  await hangUp(alicePage);
  await expect(bobPage.locator('.end-card')).toContainText(/call ended/i);
  await expectIdle(alicePage);
  await expectIdle(bobPage);
  await expect(contactRow(alicePage, bob.extension)).toHaveAttribute('data-presence', 'available');
});

test('audio call: hold, resume and mute', async () => {
  await dial(bobPage, alice.extension, false);
  await expect(alicePage.locator('.incoming-card')).toContainText(bob.name);
  await alicePage.locator('[data-action="answer-audio"]').click();

  await expectMediaFlowing(alicePage, false);
  await expectMediaFlowing(bobPage, false);
  await expect(bobPage.locator('.local-pip')).not.toHaveClass(/visible/);

  await bobPage.locator('.control', { hasText: /^hold$/i }).click();
  await expect(bobPage.locator('.call-banner')).toContainText(/on hold/i);
  // While held, Asterisk plays music on hold to Alice.
  await expect(alicePage.locator('.call-view')).toHaveAttribute('data-audio-rx', 'true');
  await bobPage.locator('.control', { hasText: /resume/i }).click();
  await expect(bobPage.locator('.call-banner')).toBeHidden();
  await expect(bobPage.locator('.call-view')).toHaveAttribute('data-audio-rx', 'true');

  const mute = alicePage.locator('.control', { hasText: /^mute$/i });
  await mute.click();
  await expect(alicePage.locator('.control', { hasText: /unmute/i })).toHaveAttribute('aria-pressed', 'true');
  await alicePage.locator('.control', { hasText: /unmute/i }).click();

  await hangUp(bobPage);
  await expectIdle(alicePage);
  await expectIdle(bobPage);
});

test('echo test (600) reflects our own audio and video', async () => {
  await dial(alicePage, '600', true);
  await expectMediaFlowing(alicePage, true);
  await hangUp(alicePage);
  await expectIdle(alicePage);
});

test('DTMF digits are sent in-band (RFC 4733) to the IVR (603)', async () => {
  await dial(alicePage, '603', false);
  await expectMediaFlowing(alicePage, false);
  await alicePage.locator('.control', { hasText: /keypad/i }).click();
  for (const key of ['4', '2', '#']) {
    await alicePage.locator(`.call-panel .key[data-key="${key}"]`).click();
    await alicePage.waitForTimeout(300);
  }
  await expect(alicePage.locator('.dtmf-display')).toHaveText('42#');
  await expect(alicePage.locator('.call-view')).toHaveAttribute('data-status', 'active');
  await alicePage.waitForTimeout(2000);
  await hangUp(alicePage);
  await expectIdle(alicePage);
});

test('declining a call gives the caller a busy signal', async () => {
  await dial(alicePage, bob.extension, false);
  await expect(bobPage.locator('.incoming-card')).toBeVisible();
  await bobPage.locator('[data-action="decline"]').click();
  await expect(alicePage.locator('.end-card')).toContainText(/busy|declined/i);
  await expectIdle(alicePage);
});

test('calling a user who is not signed in fails cleanly', async () => {
  test.skip(!carol, 'needs a third WebRTC user');
  await dial(alicePage, carol.extension, false);
  await expect(alicePage.locator('.end-card')).toContainText(/not available|unavailable/i);
  await expectIdle(alicePage);
});

test('calling an unknown number reports it', async () => {
  await dial(alicePage, '9999', false);
  await expect(alicePage.locator('.end-card')).toContainText(/not found/i);
  await expectIdle(alicePage);
});

test('blind transfer (REFER) hands the caller over to another extension', async () => {
  await dial(alicePage, bob.extension, true);
  await bobPage.locator('[data-action="answer-video"]').click();
  await expectMediaFlowing(alicePage, true);

  await bobPage.locator('.control', { hasText: /transfer/i }).click();
  await bobPage.locator('.transfer-form input').fill('600');
  await bobPage.locator('.transfer-form button[type="submit"]').click();
  await expect(bobPage.locator('.end-card')).toContainText(/transferred/i);
  await expectIdle(bobPage);

  // Alice is now talking to the echo test.
  await expect(alicePage.locator('.call-view')).toHaveAttribute('data-status', 'active');
  await alicePage.waitForTimeout(3000);
  await expectMediaFlowing(alicePage, false);
  await hangUp(alicePage);
  await expectIdle(alicePage);
});

test('call history records the calls', async () => {
  await alicePage.locator('.tab[data-tab="recents"]').click();
  await expect(alicePage.locator('.recent').first()).toBeVisible();
  expect(await alicePage.locator('.recent').count()).toBeGreaterThanOrEqual(5);
});
