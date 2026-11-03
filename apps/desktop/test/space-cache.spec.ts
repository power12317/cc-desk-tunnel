import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProxyServer } from '../../server/src/server.ts';
import { createSession } from './helpers.ts';

test('switching A/B keys on one device partitions projects, drafts and server history, and restores A on return', async ({
  page,
  baseURL,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const dataDir = mkdtempSync(join(tmpdir(), 'cc-ui-spaces-'));
  const a = `ui-a-${randomUUID()}`,
    b = `ui-b-${randomUUID()}`;
  const server = createProxyServer({
    token: '',
    accessKeys: [
      { id: 'A', token: a },
      { id: 'B', token: b },
    ],
    dataDir,
    allowedOrigins: [new URL(baseURL!).origin],
  });
  const url = (await server.listen(0)).replace('http', 'ws') + '/ws';
  try {
    await page.goto('/');
    async function login(token: string) {
      await page.getByLabel('服务地址').fill(url);
      await page.getByLabel('服务凭据').fill(token);
      await page.getByRole('button', { name: '连接', exact: true }).click();
      await expect(page.locator('.connection-status')).toContainText('已连接');
    }
    async function logout() {
      await page.getByRole('button', { name: '设置与账号', exact: true }).click();
      await page.getByRole('menuitem', { name: '断开连接', exact: true }).click();
      await expect(page.getByLabel('服务凭据')).toBeVisible();
    }
    await login(a);
    const titleA = await createSession(page, 'A private');
    const box = page.getByRole('textbox', { name: '消息' });
    await box.fill('private A draft');
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: '定时任务', exact: true }).click();
    await page.getByRole('button', { name: '新建任务', exact: true }).first().click();
    await page.getByLabel('任务名称').fill('private A schedule');
    await page.getByLabel('提示词').fill('private A scheduled prompt');
    await page.getByRole('button', { name: '保存任务', exact: true }).click();
    await expect(page.locator('.schedule-row')).toContainText('private A schedule');
    await logout();
    await login(b);
    await page.getByRole('button', { name: '定时任务', exact: true }).click();
    await expect(page.locator('.schedule-row')).toHaveCount(0);
    await page.getByRole('button', { name: '会话', exact: true }).click();
    await expect(page.getByRole('button', { name: titleA, exact: false })).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: '新建会话 · D:\\工作\\中文项目', exact: true }),
    ).toHaveCount(0);
    const titleB = await createSession(page, 'B private');
    await expect(box).toHaveValue('');
    await box.fill('private B draft');
    await page.waitForTimeout(400);
    await logout();
    await login(a);
    await expect(page.getByRole('button', { name: titleB, exact: false })).toHaveCount(0);
    await page.getByRole('button', { name: titleA, exact: false }).first().click();
    await expect(box).toHaveValue('private A draft');
    const drafts = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('proxy-drafts') ?? '{}'),
    );
    expect(Object.keys(drafts).some((key) => key.includes('|A\0'))).toBe(true);
    expect(Object.keys(drafts).some((key) => key.includes('|B\0'))).toBe(true);
    await page.getByRole('button', { name: '定时任务', exact: true }).click();
    await expect(page.locator('.schedule-row')).toContainText('private A schedule');
    expect(pageErrors).toEqual([]);
  } finally {
    await page.goto('about:blank');
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
