import {
  DndContext, DragOverlay, useDraggable, useDroppable,
} from '@dnd-kit/core';
import { useMemo, useState } from 'react';
import {
  improvable, TRAINING_BUILDINGS, researchable, tribeUnits, TRIBES, unitName, unitsFor,
} from '../game.js';
import { timeUntil } from '../util.js';
import { Icon, Stepper, useDragSensors } from './ui.jsx';

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

// Which units a list takes, and which trained units it adds on its own (fromTraining).
const SECTIONS = {
  research: { accepts: researchable, implied: /^t[2-9]$/ },
  smithy: { accepts: improvable, implied: /^t[1-8]$/ },
};

// A unit list per village ("Every village" on top, which the others use unless they have their
// own), for Academy research or Smithy upgrades.
function ListsCard({
  section, title, icon, help, switchLabel, extra, lists, rows, tribe, armed, tap, trainsNow, onSet, onRemove, status,
}) {
  const { fromTraining, units, overrides } = lists;
  const listFor = (row) => (row === DEFAULT_ROW ? units : overrides[row] ?? units);
  const accepts = (unit) => SECTIONS[section].accepts(tribe).some((u) => u.code === unit);
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h3><Icon name={icon} /> {title}</h3>
          <p className="muted small">{help}</p>
        </div>
        <div className="list-card-controls">
          {extra}
          <label className="switch">
            <input type="checkbox" checked={Boolean(fromTraining)} onChange={(e) => onSet('fromTraining', e.target.checked)} />
            <span>{switchLabel}</span>
          </label>
        </div>
      </div>
      <div className="research-list">
        {rows.map((row) => {
          const own = row.isDefault || overrides[row.key] !== undefined;
          const list = listFor(row.key);
          const implied = row.village && fromTraining ? trainsNow(row.village).filter((u) => !list.includes(u) && SECTIONS[section].implied.test(u)) : [];
          const target = { kind: 'list', section, row: row.key };
          return (
            <div key={row.key} className={`research-row ${row.isDefault ? 'is-default' : ''}`}>
              <div className="board-name">
                <strong>{row.name}</strong>
                {row.isDefault && <span className="tag">default</span>}
                {!row.isDefault && own && (
                  <button type="button" className="link small" onClick={() => onSet('overrides', withoutKey(overrides, row.key))}>use default</button>
                )}
              </div>
              <Drop id={`${section}|${row.key}`} data={target} accepts={accepts} onTap={armed ? tap(target) : undefined} className="research-drop" label={`${title} list for ${row.name}`}>
                {list.map((u) => (
                  <span key={u} className={`unit-chip static ${own ? '' : 'inherited'}`}>
                    {unitName(tribe, u)}
                    <button type="button" className="icon-btn" aria-label={`Remove ${unitName(tribe, u)}`} onClick={(e) => { e.stopPropagation(); onRemove(row.key, u); }}>
                      <Icon name="x" size={12} />
                    </button>
                  </span>
                ))}
                {implied.map((u) => <span key={u} className="unit-chip static implied" title="Included because this village trains it">{unitName(tribe, u)}</span>)}
                {!list.length && !implied.length && <span className="muted small">Drop units here</span>}
              </Drop>
              {row.village && status(row.key)}
            </div>
          );
        })}
      </div>
    </section>
  );
}

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
  const listsOf = (section) => ({
    fromTraining: draft.value(`${section}.fromTraining`),
    units: draft.value(`${section}.units`) ?? [],
    overrides: draft.value(`${section}.overrides`) ?? {},
  });
  const lists = { research: listsOf('research'), smithy: listsOf('smithy') };
  const limit = draft.value('build.populationLimit');

  // Buildings shown as columns: the three troop buildings, plus any other the settings use.
  const columns = useMemo(() => {
    const gids = new Set(TRAINING_BUILDINGS.map((b) => b.gid));
    for (const o of [trainUnits, ...Object.values(trainOverrides)]) Object.keys(o ?? {}).forEach((g) => gids.add(Number(g)));
    return [...gids].map((gid) => ({ gid, name: TRAINING_BUILDINGS.find((b) => b.gid === gid)?.name ?? `Building ${gid}` }));
  }, [trainUnits, trainOverrides]);

  const canTrainIn = (gid) => (unit) => unit === NONE || !known || unitsFor(tribe, gid).some((u) => u.code === unit);

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

  // A research or Smithy list: the default one, or a village's own.
  function setList(section, row, list) {
    if (row === DEFAULT_ROW) {
      draft.change(`${section}.units`, list);
      return;
    }
    draft.change(`${section}.overrides`, { ...lists[section].overrides, [row]: list });
  }
  const listFor = (section, row) => (row === DEFAULT_ROW ? lists[section].units : lists[section].overrides[row] ?? lists[section].units);
  const addTo = (section, row, unit) => {
    if (!SECTIONS[section].accepts(tribe).some((u) => u.code === unit)) return;
    setList(section, row, [...new Set([...listFor(section, row), unit])]);
  };
  const removeFrom = (section) => (row, unit) => setList(section, row, listFor(section, row).filter((u) => u !== unit));

  function place(target, unit) {
    if (target.kind === 'train' && canTrainIn(target.gid)(unit)) setTraining(target.row, target.gid, unit);
    if (target.kind === 'list' && unit !== NONE) addTo(target.section, target.row, unit);
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
  const smithyStatus = new Map((snapshot.smithy ?? []).map((r) => [r.village, r]));
  const rows = [{ key: DEFAULT_ROW, name: 'Every village', isDefault: true }, ...villages.map((v) => ({ key: v.name, name: v.name, village: v }))];

  const palette = (
    <div className="palette">
      <div className="palette-head">
        <h3>Units{tribe ? ` · ${TRIBES[tribe] ?? ''}` : ''}</h3>
        <p className="muted small">Drag a unit onto a building, research or Smithy list, or tap it and then tap where it goes.</p>
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

          <ListsCard
            section="research"
            title="Research"
            icon="book"
            help="The Academy researches these, one at a time, before training. Villages use the top list unless they have their own."
            switchLabel="Also research what a village trains"
            lists={lists.research}
            rows={rows}
            tribe={tribe}
            armed={armed}
            tap={tap}
            trainsNow={trainsNow}
            onSet={(key, value) => draft.change(`research.${key}`, value)}
            onRemove={removeFrom('research')}
            status={(name) => {
              const st = researchStatus.get(name);
              return st && (
                <div className="research-status small">
                  {st.started && <span className="st st-good"><Icon name="book" size={12} /> Researching {st.started}</span>}
                  {st.researched?.map((u) => <span key={u} className="st st-muted"><Icon name="check" size={12} /> {unitName(tribe, u)}</span>)}
                  {st.waiting?.map((w) => <span key={w.unit} className="st st-warn"><Icon name="pause" size={12} /> {w.name ?? unitName(tribe, w.unit)}: {w.reason}</span>)}
                </div>
              );
            }}
          />

          <ListsCard
            section="smithy"
            title="Smithy"
            icon="hammer"
            help="The Smithy improves these, one upgrade at a time, lowest level first, after research and before training. Villages use the top list unless they have their own."
            switchLabel="Also improve what a village trains"
            extra={(
              <label className="row small">
                <span className="muted">Up to level</span>
                <Stepper value={draft.value('smithy.maxLevel') ?? 20} min={1} max={20} onChange={(v) => draft.change('smithy.maxLevel', v)} label="Smithy upgrades up to level" />
              </label>
            )}
            lists={lists.smithy}
            rows={rows}
            tribe={tribe}
            armed={armed}
            tap={tap}
            trainsNow={trainsNow}
            onSet={(key, value) => draft.change(`smithy.${key}`, value)}
            onRemove={removeFrom('smithy')}
            status={(name) => {
              const st = smithyStatus.get(name);
              if (!st) return null;
              return (
                <div className="research-status small">
                  {st.note && <span className="st st-muted"><Icon name="pause" size={12} /> {st.note}</span>}
                  {st.started && <span className="st st-good"><Icon name="hammer" size={12} /> Improving {st.started}</span>}
                  {!st.started && st.running && <span className="st st-good"><Icon name="hammer" size={12} /> {st.running}</span>}
                  {Object.entries(st.levels ?? {}).map(([u, lvl]) => (
                    <span key={u} className="st st-muted">{lvl >= st.cap ? <Icon name="check" size={12} /> : null} {unitName(tribe, u)} {lvl}/{st.cap}</span>
                  ))}
                  {st.waiting?.filter((w) => w.reason !== 'after the current upgrade').map((w) => <span key={w.unit} className="st st-warn"><Icon name="pause" size={12} /> {w.name ?? unitName(tribe, w.unit)}: {w.reason}</span>)}
                  {st.nextCheckAt && !st.started && <span className="muted">next look {timeUntil(st.nextCheckAt)}</span>}
                </div>
              );
            }}
          />
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
