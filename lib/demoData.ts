// Sample data for the clearly labeled demo mode. Never mixed with live data.
import type { Channel, LineupItem, Program, Programming } from './lineup';

const HOUR = 3_600_000;
const MINUTE = 60_000;
export const demoDate = '2026-10-02';
const demoStart = new Date(`${demoDate}T06:00:00`).getTime();

const demoPrograms: Record<string, { program: Program }> = {
  earth: { program: { title: 'Fresh Water', show: { title: 'Planet Earth' }, type: 'episode', seasonNumber: 1, episodeNumber: 3, year: 2006 } },
  budapest: { program: { title: 'The Grand Budapest Hotel', type: 'movie', year: 2014 } },
  bobs: { program: { title: 'Work Hard or Die Trying, Girl', show: { title: 'Bob’s Burgers' }, type: 'episode', seasonNumber: 5, episodeNumber: 1 } },
  severance: { program: { title: 'Good News About Hell', show: { title: 'Severance' }, type: 'episode', seasonNumber: 1, episodeNumber: 1 } },
  arrival: { program: { title: 'Arrival', type: 'movie', year: 2016 } },
  office: { program: { title: 'Dinner Party', show: { title: 'The Office' }, type: 'episode', seasonNumber: 4, episodeNumber: 13 } },
  spirited: { program: { title: 'Spirited Away', type: 'movie', year: 2001 } },
  atlanta: { program: { title: 'Teddy Perkins', show: { title: 'Atlanta' }, type: 'episode', seasonNumber: 2, episodeNumber: 6 } },
  moonrise: { program: { title: 'Moonrise Kingdom', type: 'movie', year: 2012 } },
  twin: { program: { title: 'Zen, or the Skill to Catch a Killer', show: { title: 'Twin Peaks' }, type: 'episode', seasonNumber: 1, episodeNumber: 3 } },
};

const demoLineup: LineupItem[] = [
  { type: 'content', id: 'severance', duration: 57 * MINUTE },
  { type: 'content', id: 'arrival', duration: 116 * MINUTE },
  { type: 'content', id: 'office', duration: 22 * MINUTE },
  { type: 'content', id: 'spirited', duration: 125 * MINUTE },
  { type: 'content', id: 'earth', duration: 49 * MINUTE },
  { type: 'content', id: 'budapest', duration: 100 * MINUTE },
  { type: 'content', id: 'bobs', duration: 22 * MINUTE },
  { type: 'content', id: 'atlanta', duration: 41 * MINUTE },
  { type: 'content', id: 'moonrise', duration: 94 * MINUTE },
  { type: 'content', id: 'twin', duration: 47 * MINUTE },
  { type: 'flex', duration: 13 * MINUTE },
];

export const demoChannels: Channel[] = [
  { id: 'studio', name: 'Studio Selects', number: 12, startTime: demoStart, duration: 0, programCount: demoLineup.length },
  { id: 'after', name: 'After Hours', number: 24, startTime: demoStart + 2 * HOUR, duration: 0, programCount: demoLineup.length },
  { id: 'kids', name: 'Kids Room', number: 88, startTime: demoStart - HOUR, duration: 0, programCount: demoLineup.length },
];

export const demoProgramming = (): Programming => ({ lineup: structuredClone(demoLineup), programs: demoPrograms });
