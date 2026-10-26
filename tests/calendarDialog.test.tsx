// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** The routes work out a year of occurrences; under a loaded test run that can take more than the default second. */
const slow = { timeout: 8000 };
import { ScheduleCalendarDialog } from '../app/components/ScheduleCalendarDialog';
import type { Channel } from '../lib/lineup';
import { createProxyConfig, handleTunarrApi, type ProxyConfig } from '../server/tunarrProxy';

const P1 = '0b6f5c4e-1a2b-4c3d-8e9f-000000000001';
const channels = [1, 2].map((n) => ({ id: `c${n}`, number: n, name: `Channel ${n}`, startTime: 0, duration: 0, programCount: 1 })) as Channel[];

async function companion() {
  const config: ProxyConfig = createProxyConfig({ LINEUP_DATA_DIR: await mkdtemp(path.join(tmpdir(), 'lineup-calendar-ui-')), TUNARR_URL: 'http://tunarr:8000' });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const response = await handleTunarrApi({ method: init.method ?? 'GET', url, headers: { host: 'lineup.test', 'content-type': 'application/json' }, body: init.body as string | undefined }, config);
    return new Response(response.body as string, { status: response.status, headers: response.headers });
  }));
  return config;
}

/** Clicks a button once it's enabled: a click on a button still disabled by the last request is lost, as it would be for a person. */
async function clickWhenEnabled(name: string) {
  const button = screen.getByRole('button', { name }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false), slow);
  fireEvent.click(button);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ScheduleCalendarDialog', () => {
  it('saves the desk’s lineup, puts it on the calendar every year, and refuses a same-priority overlap', { timeout: 30_000 }, async () => {
    const config = await companion();
    render(<ScheduleCalendarDialog channels={channels} toSave={{ lineup: [{ type: 'content', id: P1, duration: 1_800_000 }], programs: { [P1]: { title: 'Pumpkin' } }, origin: { kind: 'desk', channelName: 'CH 1 Channel 1' } }} onClose={() => undefined} />);
    expect(await screen.findByText('Scheduled changes are off', {}, slow)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Schedule name'), { target: { value: 'Spooky' } });
    fireEvent.change(screen.getByLabelText('Schedule tags'), { target: { value: 'halloween, kids' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save to the library' }));
    const saved = await screen.findByRole('list', { name: 'Saved schedules' }, slow);
    await waitFor(() => expect(within(saved).getByText('Spooky')).toBeTruthy(), slow);
    expect(within(saved).getByText(/1 items · 30 min a pass · From the desk \(CH 1 Channel 1\) · halloween, kids/)).toBeTruthy();

    fireEvent.click(within(saved).getByRole('button', { name: 'Add to calendar…' }));
    // Yearly by default (31 October 18:00 → 1 November 06:00); pick a channel.
    fireEvent.click(screen.getByRole('checkbox', { name: /CH 1 Channel 1/ }));
    expect((screen.getByRole('button', { name: 'Save to the calendar' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Tunarr keeps no episode progress/)).toBeTruthy();
    await clickWhenEnabled('Check');
    const next = await screen.findByRole('list', { name: 'Next occurrences' }, slow);
    expect(within(next).getAllByText(/31 Oct/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Save to the calendar' }));
    const entries = await screen.findByRole('list', { name: 'Calendar entries' }, slow);
    await waitFor(() => expect(within(entries).getByText('Spooky')).toBeTruthy(), slow);
    expect(within(entries).getByText(/Every year, 31 October 18:00 → 1 November 06:00/)).toBeTruthy();
    expect((await config.calendar!.list())[0]).toMatchObject({ name: 'Spooky', start: { mode: 'restart' }, end: 'restore', channelIds: ['c1'] });

    // The same days again at the same priority on the same channel: refused before saving.
    fireEvent.click(screen.getByRole('button', { name: /^Library/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add to calendar…' }, slow));
    fireEvent.change(screen.getByLabelText('Entry name'), { target: { value: 'Second' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /CH 1 Channel 1/ }));
    await clickWhenEnabled('Check');
    const conflicts = await screen.findByRole('list', { name: 'Conflicts' }, slow);
    expect(conflicts.textContent).toContain('overlaps “Spooky” (same priority)');
    expect((screen.getByRole('button', { name: 'Save to the calendar' }) as HTMLButtonElement).disabled).toBe(true);
    // A higher priority wins instead, once checked again.
    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: '8' } });
    expect(screen.getByText('(out of date: check again)')).toBeTruthy();
    await clickWhenEnabled('Check');
    await waitFor(() => expect(screen.getByRole('list', { name: 'Conflicts' }).textContent).toContain('this one has the higher priority'), slow);
    expect((screen.getByRole('button', { name: 'Save to the calendar' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('says so when an entry was saved but what was planned couldn’t be checked', { timeout: 30_000 }, async () => {
    const config = await companion();
    const schedule = await config.scheduleLibrary!.create({ name: 'Spooky', description: '', tags: [], origin: { kind: 'desk', channelName: '' }, lineup: [{ type: 'content', id: P1, duration: 1_800_000 }], programs: {} });
    vi.spyOn(config.scheduler!.store, 'list').mockRejectedValue(new Error('scheduled.json can’t be read'));
    render(<ScheduleCalendarDialog channels={channels} toSave={null} onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Library/ }, slow));
    const saved = await screen.findByRole('list', { name: 'Saved schedules' }, slow);
    await waitFor(() => expect(within(saved).getByText(schedule.name)).toBeTruthy(), slow);
    fireEvent.click(within(saved).getByRole('button', { name: 'Add to calendar…' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /CH 1 Channel 1/ }));
    await clickWhenEnabled('Check');
    await screen.findByRole('list', { name: 'Next occurrences' }, slow);
    fireEvent.click(screen.getByRole('button', { name: 'Save to the calendar' }));
    expect((await screen.findByRole('status', {}, slow)).textContent).toContain('There’s no need to save again');
    expect(await config.calendar!.list()).toHaveLength(1);
  });
});
