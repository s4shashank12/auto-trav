import {
  closestCenter, DndContext, DragOverlay, pointerWithin, useDraggable, useDroppable,
} from '@dnd-kit/core';
import {
  arrayMove, SortableContext, useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useState } from 'react';
import { BUILDINGS, planWarnings, requirementName } from '../game.js';
import { Icon, Stepper, useDragSensors } from './ui.jsx';

const GROUPS = ['Infrastructure', 'Production', 'Military'];
const catalogEntry = (gid) => BUILDINGS.find((b) => b.gid === gid);

function PlanRow({
  item, index, warnings, onLevel, onRemove,
}) {
  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
  } = useSortable({ id: `b:${item.gid}`, data: { kind: 'plan', gid: item.gid } });
  const max = catalogEntry(item.gid)?.max ?? 20;
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={`plan-row ${isDragging ? 'dragging' : ''}`}>
      <button type="button" className="grip" aria-label={`Move ${item.name}`} {...attributes} {...listeners}>
        <Icon name="grip" />
      </button>
      <span className="plan-rank">{index + 1}</span>
      <div className="plan-main">
        <strong>{item.name}</strong>
        <div className="req">
          {Object.entries(item.requires ?? {}).map(([k, lvl]) => <span key={k} className="req-chip">{requirementName(k)} {lvl}</span>)}
        </div>
        {warnings?.map((w) => <div key={w} className="plan-warn small"><Icon name="alert" size={12} /> {w}</div>)}
      </div>
      <label className="plan-level">
        <span className="muted small">up to level</span>
        <Stepper value={item.maxLevel} min={1} max={max} onChange={(v) => onLevel(v)} label={`${item.name} level`} />
      </label>
      <button type="button" className="icon-btn" aria-label={`Remove ${item.name}`} onClick={onRemove}><Icon name="x" /></button>
    </li>
  );
}

function CatalogItem({ b, used, onAdd }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `cat:${b.gid}`, data: { kind: 'catalog', gid: b.gid }, disabled: used });
  return (
    <button
      ref={setNodeRef}
      type="button"
      className={`catalog-item ${used ? 'used' : ''} ${isDragging ? 'dragging' : ''}`}
      onClick={() => !used && onAdd(b.gid)}
      disabled={used}
      {...listeners}
      {...attributes}
    >
      {used ? <Icon name="check" size={14} /> : <Icon name="plus" size={14} />}
      {b.name}
    </button>
  );
}

function PlanDrop({ children }) {
  const { setNodeRef, isOver, active } = useDroppable({ id: 'plan' });
  const adding = active?.data.current?.kind === 'catalog';
  return <div ref={setNodeRef} className={`plan-drop ${adding ? (isOver ? 'drop-over' : 'drop-ok') : ''}`}>{children}</div>;
}

// Picks catalog drops by pointer position and list reordering by the closest row.
const collision = (args) => {
  if (args.active.data.current?.kind === 'catalog') {
    const hits = pointerWithin(args);
    return hits.length ? hits : [];
  }
  return closestCenter(args);
};

// Which buildings small villages develop, in what order and how far. Drag rows to reorder, or
// drag (or tap) buildings in from the catalog.
export default function BuildPlan({ draft }) {
  const plan = draft.value('build.buildings') ?? [];
  const sensors = useDragSensors();
  const [dragging, setDragging] = useState(null);
  const warnings = planWarnings(plan);
  const used = new Set(plan.map((b) => b.gid));
  const setPlan = (next) => draft.change('build.buildings', next);

  const newItem = (gid) => {
    const b = catalogEntry(gid);
    return {
      gid, name: b.name, maxLevel: b.max, ...(b.requires ? { requires: b.requires } : {}),
    };
  };
  const add = (gid, at = plan.length) => {
    if (used.has(gid)) return;
    const next = [...plan];
    next.splice(at, 0, newItem(gid));
    setPlan(next);
  };

  function onDragEnd({ active, over }) {
    setDragging(null);
    if (!over) return;
    const kind = active.data.current?.kind;
    const overIndex = plan.findIndex((b) => `b:${b.gid}` === over.id);
    if (kind === 'catalog') add(active.data.current.gid, overIndex >= 0 ? overIndex : plan.length);
    else if (kind === 'plan' && overIndex >= 0) {
      const from = plan.findIndex((b) => `b:${b.gid}` === active.id);
      if (from !== overIndex) setPlan(arrayMove(plan, from, overIndex));
    }
  }

  const limit = draft.value('build.populationLimit');
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={({ active }) => setDragging(active.data.current)}
      onDragCancel={() => setDragging(null)}
      onDragEnd={onDragEnd}
    >
      <div className="buildplan">
        <section className="card">
          <div className="card-head wrap">
            <div>
              <h3><Icon name="hammer" /> Build list</h3>
              <p className="muted small">
                Villages under {limit} population develop their resource fields and these buildings. The bot
                evens out progress across the list; when two buildings are equally far along, the higher one goes
                first. Drag to reorder.
              </p>
            </div>
            <div className="inline-settings">
              <label>
                <span className="muted small">Develop villages under</span>
                <Stepper value={limit} min={0} max={5000} step={50} onChange={(v) => draft.change('build.populationLimit', v)} label="population limit" />
              </label>
              <label>
                <span className="muted small">Jobs per queue</span>
                <Stepper value={draft.value('build.queueMax')} min={1} max={4} onChange={(v) => draft.change('build.queueMax', v)} label="jobs per queue" />
              </label>
            </div>
          </div>
          <PlanDrop>
            <SortableContext items={plan.map((b) => `b:${b.gid}`)} strategy={verticalListSortingStrategy}>
              <ol className="plan">
                {plan.map((item, i) => (
                  <PlanRow
                    key={item.gid}
                    item={item}
                    index={i}
                    warnings={warnings.get(item.gid)}
                    onLevel={(v) => setPlan(plan.map((b) => (b.gid === item.gid ? { ...b, maxLevel: v } : b)))}
                    onRemove={() => setPlan(plan.filter((b) => b.gid !== item.gid))}
                  />
                ))}
              </ol>
            </SortableContext>
            {!plan.length && <p className="muted center">Drag buildings here from the catalog.</p>}
          </PlanDrop>
        </section>

        <aside className="card catalog">
          <h3>Catalog</h3>
          <p className="muted small">Drag into the list, or tap to add at the end.</p>
          {GROUPS.map((g) => (
            <div key={g} className="palette-group">
              <span className="palette-title">{g}</span>
              <div className="chips">
                {BUILDINGS.filter((b) => b.group === g).map((b) => <CatalogItem key={b.gid} b={b} used={used.has(b.gid)} onAdd={add} />)}
              </div>
            </div>
          ))}
        </aside>
      </div>
      <DragOverlay dropAnimation={null}>
        {dragging?.kind === 'catalog' && <span className="catalog-item overlay"><Icon name="plus" size={14} />{catalogEntry(dragging.gid)?.name}</span>}
      </DragOverlay>
    </DndContext>
  );
}
