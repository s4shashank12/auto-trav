import {
  DndContext, DragOverlay, useDraggable, useDroppable,
} from '@dnd-kit/core';
import { useMemo, useState } from 'react';
import {
  TRAINING_BUILDINGS, researchable, tribeUnits, TRIBES, unitName, unitsFor,
} from '../game.js';
import { Icon, useDragSensors } from './ui.jsx';

const DEFAULT_ROW = '*';
const NONE = 'none';

function UnitChip({
  unit, name, kind, armed, onArm, dragId, compactChip,
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: dragId, data: { kind: 'unit', unit } });
  return (
    <button
      ref={setNodeRef}
      type="button"
      className={`unit-chip ${armed ? 'armed' : ''} ${isDragging ? 'dragging' : ''} ${compactChip ? 'compact' : ''} ${unit === NONE ? 'none' : ''}`}
      onClick={onArm}
      aria-pressed={armed}
      {...listeners}
      {...attributes}
    >
      <Icon name={unit === NONE ? 'x' : kind} size={14} />
      {name}
    </button>
  );
}

function Drop({
  id, data, accepts, onTap, className = '', children, label,
}) {
  const { setNodeRef, isOver, active } = useDroppable({ id, data });
  const unit = active?.data.current?.unit;
  const ok = unit != null && accepts(unit);
  const cls = active ? (ok ? (isOver ? 'drop-over' : 'drop-ok') : 'drop-no') : '';
  return (
    <div
      ref={setNodeRef}
      className={`drop ${cls} ${className}`}
      onClick={onTap}
      onKeyDown={(e) => { if (onTap && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onTap(); } }}
      role={onTap ? 'button' : undefined}
      tabIndex={onTap ? 0 : undefined}
      aria-label={label}
    >
      {children}
    </div>
  );
}

const withoutKey = (obj, key) => Object.fromEntries(Object.entries(obj ?? {}).filter(([k]) => k !== String(key)));

// Training and research, both as "default for every village" plus per-village overrides, edited
// by dragging units (or tapping a unit, then a slot).
export default function Army({ draft, server }) {
  const snapshot = server.snapshot ?? {};
  const tribe = snapshot.tribe ?? null;
  const villages = snapshot.villages ?? [];
  const units = tribeUnits(tribe);
  const known = units[0].known;
  const sensors = useDragSensors();
  const [armed, setArmed] = useState(null);
  const [dragging, setDragging] = useState(null);

  const trainUnits = draft.value('train.units') ?? {};
  const trainOverrides = draft.value('train.overrides') ?? {};
  const research = {
    fromTraining: draft.value('research.fromTraining'),
    units: draft.value('research.units') ?? [],
    overrides: draft.value('research.overrides') ?? {},
  };
  const limit = draft.value('build.populationLimit');

  // Buildings shown as columns: the three troop buildings, plus any other the settings use.
  const columns = useMemo(() => {
    const gids = new Set(TRAINING_BUILDINGS.map((b) => b.gid));
    for (const o of [trainUnits, ...Object.values(trainOverrides)]) Object.keys(o ?? {}).forEach((g) => gids.add(Number(g)));
    return [...gids].map((gid) => ({ gid, name: TRAINING_BUILDINGS.find((b) => b.gid === gid)?.name ?? `Building ${gid}` }));
  }, [trainUnits, trainOverrides]);

  const canTrainIn = (gid) => (unit) => unit === NONE || !known || unitsFor(tribe, gid).some((u) => u.code === unit);
  const canResearch = (unit) => researchable(tribe).some((u) => u.code === unit);

  function setTraining(row, gid, unit) {
    const key = String(gid);
    if (row === DEFAULT_ROW) {
      draft.change('train.units', unit == null ? withoutKey(trainUnits, key) : { ...trainUnits, [key]: unit });
      return;
    }
    const own = unit == null ? withoutKey(trainOverrides[row], key) : { ...(trainOverrides[row] ?? {}), [key]: unit };
    const next = { ...trainOverrides, [row]: own };
    if (!Object.keys(own).length) delete next[row];
    draft.change('train.overrides', next);
  }

  function setResearch(row, list) {
    if (row === DEFAULT_ROW) {
      draft.change('research.units', list);
      return;
    }
    const next = { ...research.overrides };
    if (list == null) delete next[row];
    else next[row] = list;
    draft.change('research.overrides', next);
  }

  const researchList = (row) => (row === DEFAULT_ROW ? research.units : research.overrides[row] ?? research.units);
  const addResearch = (row, unit) => {
    if (!canResearch(unit)) return;
    setResearch(row, [...new Set([...researchList(row), unit])]);
  };
  const removeResearch = (row, unit) => setResearch(row, researchList(row).filter((u) => u !== unit));

  function place(target, unit) {
    if (target.kind === 'train' && canTrainIn(target.gid)(unit)) setTraining(target.row, target.gid, unit);
    if (target.kind === 'research' && unit !== NONE) addResearch(target.row, unit);
  }
  const tap = (target) => () => {
    if (!armed) return;
    place(target, armed);
    setArmed(null);
  };

  function onDragEnd({ active, over }) {
    setDragging(null);
    if (over?.data.current) place(over.data.current, active.data.current.unit);
  }

  // Units a big village trains, which it also researches when fromTraining is on.
  const trainsNow = (v) => {
    if (limit != null && v.population < limit) return [];
    return columns.map(({ gid }) => trainOverrides[v.name]?.[gid] ?? trainUnits[gid]).filter((u) => u && u !== NONE);
  };
  const researchStatus = new Map((snapshot.research ?? []).map((r) => [r.village, r]));
  const rows = [{ key: DEFAULT_ROW, name: 'Every village', isDefault: true }, ...villages.map((v) => ({ key: v.name, name: v.name, village: v }))];

  const palette = (
    <div className="palette">
      <div className="palette-head">
        <h3>Units{tribe ? ` · ${TRIBES[tribe] ?? ''}` : ''}</h3>
        <p className="muted small">Drag a unit onto a building or research list, or tap it and then tap where it goes.</p>
        {!known && <p className="notice small">Unit names appear after the bot's next round (it reads your tribe then).</p>}
      </div>
      {[...columns.map((c) => ({ title: c.name, list: unitsFor(tribe, c.gid) })), { title: 'Leaders', list: units.filter((u) => u.gid === 25 && u.code !== 't10') }]
        .filter((g) => g.list.length)
        .map((g) => (
          <div key={g.title} className="palette-group">
            <span className="palette-title">{g.title}</span>
            <div className="chips">
              {g.list.map((u) => (
                <UnitChip key={u.code} dragId={`unit:${u.code}`} unit={u.code} name={u.name} kind={u.kind} armed={armed === u.code} onArm={() => setArmed(armed === u.code ? null : u.code)} />
              ))}
            </div>
          </div>
        ))}
      <div className="palette-group">
        <span className="palette-title">Idle</span>
        <div className="chips">
          <UnitChip dragId="unit:none" unit={NONE} name="Don't train" kind="x" armed={armed === NONE} onArm={() => setArmed(armed === NONE ? null : NONE)} />
        </div>
      </div>
    </div>
  );

  return (
    <DndContext
      sensors={sensors}
      onDragStart={({ active }) => { setArmed(null); setDragging(active.data.current.unit); }}
      onDragCancel={() => setDragging(null)}
      onDragEnd={onDragEnd}
    >
      <div className="army">
        <aside className="army-side">{palette}</aside>

        <div className="stack">
          <section className="card">
            <div className="card-head">
              <div>
                <h3><Icon name="foot" /> Training</h3>
                <p className="muted small">
                  Villages of {limit ?? 500}+ population keep these buildings training. A village uses the
                  top row unless it has its own choice.
                </p>
                <p className="legend small"><span className="swatch own" /> its own choice (× to undo) <span className="swatch inherited" /> same as the top row</p>
              </div>
            </div>
            <div className="board" style={{ '--cols': columns.length }}>
              <div className="board-row board-header">
                <div />
                {columns.map((c) => <div key={c.gid} className="board-col">{c.name}</div>)}
              </div>
              {rows.map((row) => {
                const small = row.village && limit != null && row.village.population < limit;
                return (
                  <div key={row.key} className={`board-row ${row.isDefault ? 'is-default' : ''} ${small ? 'is-small' : ''}`}>
                    <div className="board-name">
                      <strong>{row.name}</strong>
                      {row.isDefault && <span className="tag">default</span>}
                      {row.village && <span className="muted small">{row.village.population?.toLocaleString()} pop{small ? ` · trains from ${limit}` : ''}</span>}
                    </div>
                    {columns.map((c) => {
                      const own = row.isDefault ? trainUnits[c.gid] : trainOverrides[row.key]?.[c.gid];
                      const inherited = row.isDefault ? undefined : trainUnits[c.gid];
                      const shown = own ?? inherited;
                      const target = { kind: 'train', row: row.key, gid: c.gid };
                      return (
                        <Drop
                          key={c.gid}
                          id={`train|${row.key}|${c.gid}`}
                          data={target}
                          accepts={canTrainIn(c.gid)}
                          onTap={armed ? tap(target) : undefined}
                          className={`board-cell ${row.isDefault || own !== undefined ? 'is-own' : 'is-inherited'}`}
                          label={`${row.name}, ${c.name}`}
                        >
                          <span className="cell-label">{c.name}</span>
                          <span className={`cell-value ${own === undefined ? 'inherited' : 'own'} ${shown === NONE || !shown ? 'idle' : ''}`}>
                            {!shown || shown === NONE ? "Doesn't train" : unitName(tribe, shown)}
                          </span>
                          {own !== undefined && !row.isDefault && (
                            <button type="button" className="icon-btn" title="Use the default" aria-label={`Use the default for ${row.name} ${c.name}`} onClick={(e) => { e.stopPropagation(); setTraining(row.key, c.gid, undefined); }}>
                              <Icon name="x" size={12} />
                            </button>
                          )}
                        </Drop>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <div>
                <h3><Icon name="book" /> Research</h3>
                <p className="muted small">The Academy researches these, one at a time, before training. Villages use the top list unless they have their own.</p>
              </div>
              <label className="switch">
                <input type="checkbox" checked={Boolean(research.fromTraining)} onChange={(e) => draft.change('research.fromTraining', e.target.checked)} />
                <span>Also research what a village trains</span>
              </label>
            </div>
            <div className="research-list">
              {rows.map((row) => {
                const own = row.isDefault || research.overrides[row.key] !== undefined;
                const list = researchList(row.key);
                const implied = row.village && research.fromTraining ? trainsNow(row.village).filter((u) => !list.includes(u) && /^t[2-9]$/.test(u)) : [];
                const status = row.village && researchStatus.get(row.key);
                const target = { kind: 'research', row: row.key };
                return (
                  <div key={row.key} className={`research-row ${row.isDefault ? 'is-default' : ''}`}>
                    <div className="board-name">
                      <strong>{row.name}</strong>
                      {row.isDefault && <span className="tag">default</span>}
                      {!row.isDefault && own && (
                        <button type="button" className="link small" onClick={() => setResearch(row.key, undefined)}>use default</button>
                      )}
                    </div>
                    <Drop id={`research|${row.key}`} data={target} accepts={canResearch} onTap={armed ? tap(target) : undefined} className="research-drop" label={`Research list for ${row.name}`}>
                      {list.map((u) => (
                        <span key={u} className={`unit-chip static ${own ? '' : 'inherited'}`}>
                          {unitName(tribe, u)}
                          <button type="button" className="icon-btn" aria-label={`Remove ${unitName(tribe, u)}`} onClick={(e) => { e.stopPropagation(); removeResearch(row.key, u); }}>
                            <Icon name="x" size={12} />
                          </button>
                        </span>
                      ))}
                      {implied.map((u) => <span key={u} className="unit-chip static implied" title="Researched because this village trains it">{unitName(tribe, u)}</span>)}
                      {!list.length && !implied.length && <span className="muted small">Drop units here</span>}
                    </Drop>
                    {status && (
                      <div className="research-status small">
                        {status.started && <span className="st st-good"><Icon name="book" size={12} /> Researching {status.started}</span>}
                        {status.researched?.map((u) => <span key={u} className="st st-muted"><Icon name="check" size={12} /> {unitName(tribe, u)}</span>)}
                        {status.waiting?.map((w) => <span key={w.unit} className="st st-warn"><Icon name="pause" size={12} /> {w.name ?? unitName(tribe, w.unit)}: {w.reason}</span>)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      </div>
      <DragOverlay dropAnimation={null}>
        {dragging && (
          <span className="unit-chip overlay">
            <Icon name={dragging === NONE ? 'x' : units.find((u) => u.code === dragging)?.kind} size={14} />
            {dragging === NONE ? "Don't train" : unitName(tribe, dragging)}
          </span>
        )}
      </DragOverlay>
    </DndContext>
  );
}
