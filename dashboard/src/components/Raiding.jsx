import {
  closestCenter, DndContext, pointerWithin, useDraggable, useDroppable,
} from '@dnd-kit/core';
import {
  arrayMove, SortableContext, useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { tribeUnits } from '../game.js';
import { Icon, Stepper, useDragSensors } from './ui.jsx';

// Farm list names are at most 30 characters, so long unit names get initials there.
const shortName = (name) => (name.length <= 17 ? name : name.split(/\s+/).map((w) => w[0]).join('').toUpperCase());

function Row({
  listId, item, unit, onCount, onRemove, index,
}) {
  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
  } = useSortable({ id: `${listId}:${item.unit}`, data: { kind: 'row', listId } });
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={`plan-row ${isDragging ? 'dragging' : ''}`}>
      <button type="button" className="grip" aria-label={`Move ${unit?.name}`} {...attributes} {...listeners}><Icon name="grip" /></button>
      <span className="plan-rank">{index + 1}</span>
      <div className="plan-main">
        <strong><Icon name={unit?.kind ?? 'foot'} size={14} /> {unit?.name ?? item.unit}</strong>
      </div>
      <label className="plan-level">
        <span className="muted small">troops per raid</span>
        <Stepper value={item.perSlot} min={1} max={500} onChange={onCount} label={`${unit?.name} per raid`} />
      </label>
      <button type="button" className="icon-btn" aria-label={`Remove ${unit?.name}`} onClick={onRemove}><Icon name="x" /></button>
    </li>
  );
}

function AddChip({ listId, unit, onAdd }) {
  const { attributes, listeners, setNodeRef } = useDraggable({ id: `${listId}-add:${unit.code}`, data: { kind: 'add', listId, unit: unit.code } });
  return (
    <button ref={setNodeRef} type="button" className="catalog-item" onClick={() => onAdd(unit.code)} {...listeners} {...attributes}>
      <Icon name="plus" size={14} />{unit.name}
    </button>
  );
}

function ListDrop({ id, children }) {
  const { setNodeRef, isOver, active } = useDroppable({ id });
  const adding = active?.data.current?.kind === 'add' && active.data.current.listId === id;
  return <div ref={setNodeRef} className={`plan-drop ${adding ? (isOver ? 'drop-over' : 'drop-ok') : ''}`}>{children}</div>;
}

const collision = (args) => (args.active.data.current?.kind === 'add' ? pointerWithin(args) : closestCenter(args));

// An ordered list of units with a troop count each. Drag to reorder; add from the chips below.
function UnitList({
  id, title, help, items, tribe, candidates, makeItem, onChange,
}) {
  const sensors = useDragSensors();
  const units = tribeUnits(tribe);
  const byCode = new Map(units.map((u) => [u.code, u]));
  const have = new Set(items.map((i) => i.unit));
  const add = (code, at = items.length) => {
    if (have.has(code)) return;
    const next = [...items];
    next.splice(at, 0, makeItem(byCode.get(code)));
    onChange(next);
  };
  function onDragEnd({ active, over }) {
    if (!over) return;
    const overIndex = items.findIndex((i) => `${id}:${i.unit}` === over.id);
    if (active.data.current?.kind === 'add') add(active.data.current.unit, overIndex >= 0 ? overIndex : items.length);
    else if (overIndex >= 0) {
      const from = items.findIndex((i) => `${id}:${i.unit}` === active.id);
      if (from !== overIndex) onChange(arrayMove(items, from, overIndex));
    }
  }
  return (
    <section className="card">
      <h3>{title}</h3>
      <p className="muted small">{help}</p>
      <DndContext sensors={sensors} collisionDetection={collision} onDragEnd={onDragEnd}>
        <ListDrop id={id}>
          <SortableContext items={items.map((i) => `${id}:${i.unit}`)} strategy={verticalListSortingStrategy}>
            <ol className="plan">
              {items.map((item, i) => (
                <Row
                  key={item.unit}
                  listId={id}
                  item={item}
                  index={i}
                  unit={byCode.get(item.unit)}
                  onCount={(v) => onChange(items.map((x) => (x.unit === item.unit ? { ...x, perSlot: v, ...(x.planUnits != null ? { planUnits: v } : {}) } : x)))}
                  onRemove={() => onChange(items.filter((x) => x.unit !== item.unit))}
                />
              ))}
            </ol>
          </SortableContext>
          {!items.length && <p className="muted center">Add a unit below.</p>}
        </ListDrop>
        <div className="chips add-row">
          {candidates.filter((u) => !have.has(u.code)).map((u) => <AddChip key={u.code} listId={id} unit={u} onAdd={add} />)}
        </div>
      </DndContext>
    </section>
  );
}

const NUMBERS = [
  ['raid.everyMinutes', 'Send a wave every', 'min', 1, 120],
  ['raid.radius', 'Oases within', 'fields', 5, 200],
  ['raid.listSize', 'Targets per farm list', '', 10, 100],
];

export default function Raiding({ draft, server }) {
  const tribe = server.snapshot?.tribe ?? null;
  const fighters = tribeUnits(tribe).filter((u) => ['foot', 'horse'].includes(u.kind));
  return (
    <div className="stack">
      <section className="card">
        <h3><Icon name="target" /> Oasis raids</h3>
        <p className="muted small">Only unoccupied oases without animals are raided, through the bot's own farm lists.</p>
        <div className="inline-settings">
          {NUMBERS.map(([path, label, unit, min, max]) => (
            <label key={path}>
              <span className="muted small">{label}</span>
              <span className="row">
                <Stepper value={draft.value(path)} min={min} max={max} onChange={(v) => draft.change(path, v)} label={label} />
                {unit && <span className="muted small">{unit}</span>}
              </span>
            </label>
          ))}
        </div>
      </section>
      <div className="two-col">
        <UnitList
          id="raid"
          title="Oasis raid troops"
          help="Slowest first: the first unit takes the nearest oases, faster ones the farther ones. Each gets its own farm lists."
          tribe={tribe}
          candidates={fighters}
          items={draft.value('raid.units') ?? []}
          makeItem={(u) => ({
            unit: u.code, name: u.name, short: shortName(u.name), perSlot: 10, planUnits: 10,
          })}
          onChange={(v) => draft.change('raid.units', v)}
        />
        <UnitList
          id="inactive"
          title="Inactive player raid troops"
          help="In order of preference: each village raids with the first unit it has enough of."
          tribe={tribe}
          candidates={fighters}
          items={draft.value('inactive.units') ?? []}
          makeItem={(u) => ({ unit: u.code, perSlot: 10 })}
          onChange={(v) => draft.change('inactive.units', v)}
        />
      </div>
    </div>
  );
}
