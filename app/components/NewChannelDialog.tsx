'use client';

import { useEffect, useState } from 'react';
import type { Channel } from '../../lib/lineup';
import type { TranscodeProfile } from '../../lib/library';
import { tunarrApi } from '../../lib/tunarrClient';

type Props = {
  channels: Channel[];
  /** Pre-selects "copy of" this channel (Channel → Duplicate). */
  copyFrom?: string;
  onClose: () => void;
  onCreated: (channelId: string) => void;
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong.');

export function NewChannelDialog({ channels, copyFrom = '', onClose, onCreated }: Props) {
  const nextNumber = channels.reduce((max, channel) => Math.max(max, channel.number), 0) + 1;
  const source = channels.find((channel) => channel.id === copyFrom);
  const [name, setName] = useState(source ? `${source.name} (copy)` : `Channel ${nextNumber}`);
  const [number, setNumber] = useState(nextNumber);
  const [group, setGroup] = useState('tunarr');
  const [start, setStart] = useState(copyFrom);
  const [profiles, setProfiles] = useState<TranscodeProfile[]>([]);
  const [profileId, setProfileId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    tunarrApi.transcodeProfiles()
      .then((items) => {
        if (cancelled) return;
        setProfiles(items);
        setProfileId((items.find((item) => item.isDefault) ?? items[0])?.id ?? '');
      })
      .catch(() => { /* Tunarr picks its default profile. */ });
    return () => { cancelled = true; };
  }, []);

  const taken = channels.some((channel) => channel.number === number);
  const valid = name.trim().length > 0 && Number.isInteger(number) && number >= 1 && !taken;

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const created = await tunarrApi.createChannel({ name: name.trim(), number, groupTitle: group.trim() || 'tunarr', ...(start ? { copyFrom: start } : { transcodeConfigId: profileId || undefined }) });
      onCreated(created.id);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" role="presentation">
      <section className="modal new-channel-modal" role="dialog" aria-modal="true" aria-labelledby="new-channel-title">
        <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <p className="eyebrow">CHANNEL</p>
        <h2 id="new-channel-title">{start ? 'Duplicate channel' : 'New channel'}</h2>
        <div className="settings-grid">
          <label className="field"><span>Start from</span><select aria-label="Start from" value={start} onChange={(event) => setStart(event.target.value)}>
            <option value="">An empty channel</option>
            {channels.map((channel) => <option key={channel.id} value={channel.id}>A copy of CH {channel.number} {channel.name}</option>)}
          </select></label>
          <label className="field"><span>Name</span><input aria-label="Channel name" value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label className="field"><span>Number</span><input type="number" min={1} step={1} aria-label="Channel number" value={number} onChange={(event) => setNumber(Math.round(Number(event.target.value)))} /></label>
          <label className="field"><span>Group</span><input aria-label="Channel group" value={group} onChange={(event) => setGroup(event.target.value)} /></label>
          {!start && profiles.length > 0 && <label className="field"><span>Transcode profile</span><select aria-label="Transcode profile" value={profileId} onChange={(event) => setProfileId(event.target.value)}>
            {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}{profile.isDefault ? ' (default)' : ''}</option>)}
          </select></label>}
        </div>
        {taken && <p className="slot-problem">Channel {number} already exists.</p>}
        <p className="subtle">{start ? 'The copy gets the same programming, schedule, filler and streaming settings.' : 'The channel starts empty. Insert programs or create a slot schedule next.'}</p>
        {error && <div className="warning" role="alert"><b>Not created</b><span>{error}</span></div>}
        <div className="dialog-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!valid || busy} onClick={() => void create()}>{busy ? 'Creating…' : start ? 'Duplicate channel' : 'Create channel'}</button>
        </div>
      </section>
    </div>
  );
}
