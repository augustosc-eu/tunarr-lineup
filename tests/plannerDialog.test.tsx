// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlannerDialog } from '../app/components/PlannerDialog';
import type { Channel } from '../lib/lineup';

const SHOW = 'c0000000-0000-4000-8000-000000000001';
const episode = (n: number) => ({ type: 'content', id: `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`, duration: 30 * 60_000, program: { type: 'episode', title: `Episode ${n}`, seasonNumber: 1, episodeNumber: n, genres: [{ name: 'Comedy' }] } });

function fakeCompanion(length = 30 * 60_000) {
  const saves: Array<{ body: Record<string, unknown>; ifMatch: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const reply = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
    if (url === '/api/tunarr/custom-shows') return reply([{ id: SHOW, name: 'Sitcoms', contentCount: 6, synced: false }]);
    if (url === `/api/tunarr/custom-shows/${SHOW}/programs`) return reply([1, 2, 3, 4, 5, 6].map((n) => ({ ...episode(n), duration: length })));
    if (url.endsWith('/programming') && init.method === 'POST') {
      saves.push({ body: JSON.parse(String(init.body)), ifMatch: String((init.headers as Record<string, string>)['if-match']) });
      return reply({ lineup: [], startTime: 0 });
    }
    return new Response('{}', { status: 404 });
  }));
  return saves;
}

const channel = { id: 'chan-1', number: 3, name: 'Newsroom', startTime: 0, duration: 0, programCount: 0 } as Channel;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PlannerDialog', () => {
  it('previews a plan and saves exactly that lineup, with its seed and start time, conditionally', async () => {
    const saves = fakeCompanion();
    const onSaved = vi.fn();
    render(<PlannerDialog channel={channel} version="v-1" dirty={false} generated={false} onSaved={onSaved} onClose={() => undefined} />);
    expect(screen.getByText(/won’t change by itself when the library changes/)).toBeTruthy();
    const add = await screen.findByRole('combobox', { name: 'Add a custom show' });
    await waitFor(() => expect(within(add).getByRole('option', { name: 'Sitcoms' })).toBeTruthy());
    fireEvent.change(add, { target: { value: SHOW } });
    expect(await screen.findByRole('group', { name: /Sitcoms · 6 programs · 3 h 00 min/ })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Days to plan'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Seed'), { target: { value: 'fixed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    const airings = await screen.findByRole('list', { name: 'Planned airings' });
    expect(within(airings).getAllByRole('listitem').length).toBe(48);
    expect(screen.getByText('Preview · seed fixed')).toBeTruthy();
    expect(screen.getByText(/Comedy 24 h 00 min/)).toBeTruthy();
    // A source repeating to fill a day says so.
    expect(screen.getByText(/went round 8 times/)).toBeTruthy();

    // Changing anything makes the preview out of date until it's previewed again.
    fireEvent.change(screen.getByLabelText('Seed'), { target: { value: 'other' } });
    expect((screen.getByRole('button', { name: 'Save to CH 3…' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Seed'), { target: { value: 'fixed' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save to CH 3…' }));
    expect(screen.getByText('Replace CH 3’s whole lineup with this plan?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Replace and save to CH 3' }));
    await waitFor(() => expect(saves).toHaveLength(1));
    const { body, ifMatch } = saves[0];
    expect(ifMatch).toBe('"v-1"');
    expect(body).toMatchObject({ type: 'manual', append: false });
    expect(typeof body.startTime).toBe('number');
    expect((body.lineup as unknown[]).length).toBe(48);
    expect((body.lineup as Array<{ id: string }>).slice(0, 2).map((item) => item.id)).toEqual([episode(1).id, episode(2).id]);
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.stringContaining('seed fixed')));
  });

  it('won’t replace a lineup with unsaved desk edits or a slot schedule', async () => {
    fakeCompanion();
    render(<PlannerDialog channel={channel} version="v-1" dirty generated={false} onSaved={() => undefined} onClose={() => undefined} />);
    const add = await screen.findByRole('combobox', { name: 'Add a custom show' });
    await waitFor(() => expect(within(add).getByRole('option', { name: 'Sitcoms' })).toBeTruthy());
    fireEvent.change(add, { target: { value: SHOW } });
    await screen.findByRole('group', { name: /Sitcoms/ });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText(/unsaved edits on this channel/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save to CH 3…' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('explains and refuses to save a plan the limit cut short', async () => {
    // One-second programs over a month need millions of airings: far past the planner's limit.
    const saves = fakeCompanion(1000);
    render(<PlannerDialog channel={channel} version="v-1" dirty={false} generated={false} onSaved={() => undefined} onClose={() => undefined} />);
    const add = await screen.findByRole('combobox', { name: 'Add a custom show' });
    await waitFor(() => expect(within(add).getByRole('option', { name: 'Sitcoms' })).toBeTruthy());
    fireEvent.change(add, { target: { value: SHOW } });
    await screen.findByRole('group', { name: /Sitcoms/ });
    fireEvent.change(screen.getByLabelText('Days to plan'), { target: { value: '31' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    const alert = await screen.findByText('This plan is incomplete and can’t be saved');
    expect(alert.parentElement!.textContent).toMatch(/limit of 50,000 programs.*plan fewer days, or use longer programs/);
    expect((screen.getByRole('button', { name: 'Save to CH 3…' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Save to the schedule library' }) as HTMLButtonElement).disabled).toBe(true);
    expect(saves).toEqual([]);
  }, 20_000);
});
