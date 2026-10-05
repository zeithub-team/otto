'use client';

/* zeithub.alertas inside otto: the extension dashboard (same markup, classes and styles — see alertas.css).
   Reminders and the timer fire from PluginRuntime, so they work with the panel closed. */

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import './alertas.css';
import { alertas, playSound, useAlertas, type Reminder } from '../../lib/alertasStore';

const pad = (n: number): string => String(n).padStart(2, '0');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const sameDay = (a: Date, b: Date): boolean => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const dateValue = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeValue = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

export function formatLeft(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

interface Form { id: string; title: string; date: string; time: string; notes: string; isNew: boolean }

export function AlertasPanel() {
  const { reminders, timer } = useAlertas();
  const now0 = new Date();
  const [view, setView] = useState({ year: now0.getFullYear(), month: now0.getMonth() });
  const [form, setForm] = useState<Form | null>(null);
  const [tMin, setTMin] = useState('');
  const [tSec, setTSec] = useState('');
  const [tLabel, setTLabel] = useState('');
  const [toastText, setToastText] = useState('');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 250); return () => window.clearInterval(id); }, []);

  const toast = (t: string) => { setToastText(t); window.setTimeout(() => setToastText(''), 1600); };
  const today = new Date();
  const cells = useMemo(() => {
    const first = new Date(view.year, view.month, 1);
    const lead = (first.getDay() + 6) % 7;
    return Array.from({ length: 42 }, (_, i) => new Date(view.year, view.month, 1 - lead + i));
  }, [view]);
  const upcoming = reminders.filter((r) => !r.done && r.when >= now).sort((a, b) => a.when - b.when).slice(0, 6);

  const openRem = (rem: Reminder | null, preset?: Date) => {
    if (rem) { const d = new Date(rem.when); setForm({ id: rem.id, title: rem.title, date: dateValue(d), time: timeValue(d), notes: rem.notes, isNew: false }); return; }
    setForm({ id: crypto.randomUUID(), title: '', date: dateValue(preset ?? new Date()), time: timeValue(new Date()), notes: '', isNew: true });
  };
  const saveRem = (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    const when = new Date(`${form.date}T${form.time}`).getTime();
    if (Number.isNaN(when)) { toast('Set date and time'); return; }
    const old = reminders.find((r) => r.id === form.id);
    alertas.save({ id: form.id, title: form.title.trim(), notes: form.notes.trim(), when, done: false, fired: old && old.when === when ? old.fired : false });
    setForm(null);
    toast(when > Date.now() ? 'Reminder set' : 'Saved (time already passed)');
  };
  const start = (seconds: number) => {
    if (!seconds || seconds <= 0) { toast('Set a duration'); return; }
    alertas.startTimer(seconds, tLabel.trim() || 'Timer');
    toast('Timer started');
  };
  const left = timer?.running ? timer.endsAt - now : 0;

  return (
    <div className="zh-al">
      <header className="top">
        <div className="brand">
          <div className="logo"><svg viewBox="0 0 24 24" style={{ width: 24, height: 24 }}><path d="M12 3.4a1.5 1.5 0 011.5 1.5v.5a6 6 0 014.5 5.8v2.8l1.4 2.3H4.6L6 14v-2.8a6 6 0 014.5-5.8v-.5A1.5 1.5 0 0112 3.4z" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M9.7 19.4a2.3 2.3 0 004.6 0" fill="none" stroke="currentColor" strokeWidth="1.8" /></svg></div>
          <div><h1>zeithub<span>.alertas</span></h1><p>Reminders calendar and timer</p></div>
        </div>
        <button className="btn-ghost" onClick={() => { playSound('timer'); toast('🔊'); }}>🔊 Test sound</button>
      </header>

      <div className="grid">
        <section className="panel calendar">
          <div className="cal-head">
            <button className="nav-btn" onClick={() => setView((v) => (v.month === 0 ? { year: v.year - 1, month: 11 } : { ...v, month: v.month - 1 }))}>‹</button>
            <h2>{MONTHS[view.month]} {view.year}</h2>
            <button className="nav-btn" onClick={() => setView((v) => (v.month === 11 ? { year: v.year + 1, month: 0 } : { ...v, month: v.month + 1 }))}>›</button>
            <button className="btn-ghost small" onClick={() => setView({ year: today.getFullYear(), month: today.getMonth() })}>Today</button>
          </div>
          <div className="weekdays">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <span key={d}>{d}</span>)}</div>
          <div className="cal-grid">
            {cells.map((d, i) => {
              const events = reminders.filter((r) => sameDay(new Date(r.when), d)).sort((a, b) => a.when - b.when);
              return (
                <div key={i} className={`day${d.getMonth() !== view.month ? ' other' : ''}${sameDay(d, today) ? ' today' : ''}`} onClick={() => openRem(null, d)}>
                  <div className="num">{d.getDate()}</div>
                  <div className="dots">
                    {events.slice(0, 3).map((ev) => (
                      <div key={ev.id} className={`ev${ev.done ? ' done' : ''}`} onClick={(e) => { e.stopPropagation(); openRem(ev); }}>
                        {timeValue(new Date(ev.when))} {ev.title}
                      </div>
                    ))}
                    {events.length > 3 && <div className="ev more">+{events.length - 3}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <div className="side">
          <section className="panel timer">
            <h2>⏱ Timer</h2>
            <div className="timer-display">{timer?.running ? formatLeft(left) : '00:00'}</div>
            <div className="timer-quick">
              {[[5, '5 min'], [10, '10 min'], [25, '25 min'], [60, '1 hour']].map(([m, l]) => <button key={m} className="chip" onClick={() => start(Number(m) * 60)}>{l}</button>)}
            </div>
            <div className="timer-custom">
              <input type="number" min={0} max={600} placeholder="min" value={tMin} onChange={(e) => setTMin(e.target.value)} />
              <input type="number" min={0} max={59} placeholder="sec" value={tSec} onChange={(e) => setTSec(e.target.value)} />
              <input id="tLabel" type="text" placeholder="Label (optional)" value={tLabel} onChange={(e) => setTLabel(e.target.value)} />
            </div>
            <div className="timer-actions">
              <button className="btn-primary" onClick={() => start((parseInt(tMin || '0', 10) || 0) * 60 + (parseInt(tSec || '0', 10) || 0))}>Start</button>
              <button className="btn-ghost" onClick={() => { alertas.stopTimer(); toast('Timer stopped'); }}>Stop</button>
            </div>
            <p className="hint">While the timer runs, the countdown shows on the plugin icon in the header.</p>
          </section>

          <section className="panel upcoming">
            <h2>🔔 Upcoming</h2>
            <ul className="up-list">
              {upcoming.map((r) => {
                const d = new Date(r.when);
                return (
                  <li key={r.id} className={`up-item${r.done ? ' done' : ''}`}>
                    <span className="up-when" onClick={() => openRem(r)}>{pad(d.getDate())}.{pad(d.getMonth() + 1)} {timeValue(d)}</span>
                    <span className="up-title" onClick={() => openRem(r)}>{r.title}</span>
                    <button className="up-check" title="Done" onClick={(e) => { e.stopPropagation(); alertas.save({ ...r, done: true }); }}>✓</button>
                  </li>
                );
              })}
            </ul>
            {upcoming.length === 0 && <p className="hint">No reminders. Click a day in the calendar.</p>}
          </section>
        </div>
      </div>

      {form && (
        <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setForm(null); }} onKeyDown={(e) => { if (e.key === 'Escape') setForm(null); }}>
          <div className="modal">
            <h2>{form.isNew ? 'New reminder' : 'Reminder'}</h2>
            <form id="remForm" onSubmit={saveRem}>
              <label>Title<input type="text" placeholder="e.g. Call the bank" required autoFocus value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
              <div className="two">
                <label>Date <input type="date" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></label>
                <label>Time <input type="time" required value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} /></label>
              </div>
              <label>Note<textarea rows={2} placeholder="Optional…" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
              <div className="modal-actions">
                {!form.isNew && <button type="button" className="btn-ghost danger-text" onClick={() => { alertas.remove(form.id); setForm(null); toast('Deleted'); }}>Delete</button>}
                <button type="button" className="btn-ghost" onClick={() => setForm(null)}>Cancel</button>
                <button type="submit" className="btn-primary">Save</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {toastText && <div className="toast">{toastText}</div>}
    </div>
  );
}
