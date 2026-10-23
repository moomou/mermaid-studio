import type { FlowGraph, Section, Structure } from './model.ts';

interface Atom {
  id: string;
  entities: string[];
  mass: number;
  order: number;
}

interface Community {
  atoms: Atom[];
  volume: number;
}

export function buildStructure(graph: FlowGraph, automatic = true): Structure {
  const entities = [...graph.nodes, ...graph.groups];
  const parents = new Map(entities.map(entity => [entity.id, entity.parent]));
  const groupIds = new Set(graph.groups.map(group => group.id));
  const nodeIds = new Set(graph.nodes.map(node => node.id));
  const atomByEntity = new Map<string, string>();
  const atomMap = new Map<string, Atom>();
  entities.forEach((entity, order) => {
    let root = entity.id;
    while (parents.get(root)) root = parents.get(root)!;
    atomByEntity.set(entity.id, root);
    let atom = atomMap.get(root);
    if (!atom) {
      atom = { id: root, entities: [], mass: 0, order };
      atomMap.set(root, atom);
    }
    atom.entities.push(entity.id);
    if (nodeIds.has(entity.id)) atom.mass++;
  });
  const atoms = [...atomMap.values()];
  const atomIndex = new Map(atoms.map((atom, index) => [atom.id, index]));
  const adjacency = atoms.map(() => atoms.map(() => 0));
  const internalPredecessors = new Set(graph.edges
    .filter(edge => edge.stroke !== 'dotted' && edge.stroke !== 'invisible')
    .filter(edge => atomByEntity.get(edge.source) === atomByEntity.get(edge.target))
    .map(edge => edge.target));
  const primaryEdges = graph.edges.filter(edge =>
    edge.stroke !== 'dotted' && edge.stroke !== 'invisible' && edge.endMarker !== 'none');
  const primaryTargets = new Set(primaryEdges.map(edge => edge.target));
  const independentFlows = new Set(atoms.filter(atom => {
    if (!groupIds.has(atom.id)) return false;
    const incoming = primaryEdges.filter(edge =>
      atomByEntity.get(edge.target) === atom.id && atomByEntity.get(edge.source) !== atom.id);
    return incoming.length > 0 && incoming.every(edge => internalPredecessors.has(edge.target))
      && atom.entities.some(id => nodeIds.has(id) && !primaryTargets.has(id));
  }).map(atom => atom.id));
  let totalWeight = 0;
  for (const edge of graph.edges) {
    const a = atomIndex.get(atomByEntity.get(edge.source)!)!;
    const b = atomIndex.get(atomByEntity.get(edge.target)!)!;
    // Joining an already-running flow is a weaker structural tie than entering
    // its first step (for example, a control connection into a serving system).
    const joinsExistingFlow = a !== b && internalPredecessors.has(edge.target);
    const weight = edge.stroke === 'dotted' ? 0.12 : edge.stroke === 'invisible' ? 0 : joinsExistingFlow ? 0.2 : 1;
    adjacency[a][b] += weight;
    adjacency[b][a] += weight;
    totalWeight += weight;
  }
  let communities: Community[] = atoms.map((atom, index) => ({
    atoms: [atom],
    volume: adjacency[index].reduce((a, b) => a + b, 0),
  }));

  if (automatic) {
    const degree = new Map<string, number>();
    for (const edge of graph.edges.filter(edge => edge.stroke === 'normal' || edge.stroke === 'thick')) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    }
    const branching = [...degree.values()].some(value => value > 2);
    const target = graph.nodes.length < 9 && !graph.groups.length || (!branching && !graph.groups.length)
      ? 1
      : Math.max(graph.groups.filter(group => !group.parent).length >= 3 ? 3 : 2,
        Math.min(6, Math.round(Math.sqrt(graph.nodes.length / 2))));

    // Contract declared subgraphs first, then merge by weighted modularity.
    // Dotted feedback has low influence; disconnected components are never joined.
    while (communities.length > target && totalWeight > 0) {
      let best: { a: number; b: number; score: number } | undefined;
      for (let a = 0; a < communities.length; a++) {
        for (let b = a + 1; b < communities.length; b++) {
          const left = communities[a];
          const right = communities[b];
          if ([...left.atoms, ...right.atoms].some(atom => independentFlows.has(atom.id))) continue;
          let weight = 0;
          for (const x of left.atoms) for (const y of right.atoms) {
            weight += adjacency[atomIndex.get(x.id)!][atomIndex.get(y.id)!];
          }
          if (!weight) continue;
          const score = weight / totalWeight - left.volume * right.volume / (2 * totalWeight ** 2);
          if (!best || score > best.score + 1e-10) best = { a, b, score };
        }
      }
      if (!best) break;
      const left = communities[best.a];
      const right = communities[best.b];
      communities[best.a] = { atoms: [...left.atoms, ...right.atoms], volume: left.volume + right.volume };
      communities.splice(best.b, 1);
    }
  } else {
    const ungrouped = communities.filter(community => !groupIds.has(community.atoms[0].id));
    communities = communities.filter(community => groupIds.has(community.atoms[0].id));
    if (ungrouped.length) communities.push({
      atoms: ungrouped.flatMap(community => community.atoms),
      volume: ungrouped.reduce((sum, community) => sum + community.volume, 0),
    });
  }

  const communityByEntity = new Map<string, Community>();
  for (const community of communities) for (const atom of community.atoms) for (const id of atom.entities) {
    communityByEntity.set(id, community);
  }
  const outgoing = new Map(communities.map(community => [community, new Set<Community>()]));
  const incoming = new Map(communities.map(community => [community, 0]));
  for (const edge of graph.edges) {
    if (edge.stroke === 'dotted' || edge.stroke === 'invisible' || edge.endMarker === 'none') continue;
    const source = communityByEntity.get(edge.source)!;
    const target = communityByEntity.get(edge.target)!;
    if (source !== target && !outgoing.get(source)!.has(target)) {
      outgoing.get(source)!.add(target);
      incoming.set(target, incoming.get(target)! + 1);
    }
  }
  const order = (community: Community) => Math.min(...community.atoms.map(atom => atom.order));
  const remaining = new Set(communities);
  const ordered: Community[] = [];
  while (remaining.size) {
    const ready = [...remaining].filter(community => !incoming.get(community));
    const next = (ready.length ? ready : [...remaining]).sort((a, b) => order(a) - order(b))[0];
    ordered.push(next);
    remaining.delete(next);
    for (const target of outgoing.get(next)!) incoming.set(target, incoming.get(target)! - 1);
  }

  const labels = new Map(entities.map(entity => [entity.id, entity.label]));
  const sections: Section[] = ordered.map((community, index) => {
    const ids = community.atoms.flatMap(atom => atom.entities);
    const idSet = new Set(ids);
    const forwardIn = new Map(community.atoms.map(atom => [atom.id, 0]));
    for (const edge of graph.edges) {
      if (edge.stroke === 'dotted' || edge.stroke === 'invisible') continue;
      const a = atomByEntity.get(edge.source)!;
      const b = atomByEntity.get(edge.target)!;
      if (a !== b && idSet.has(edge.source) && idSet.has(edge.target)) {
        forwardIn.set(b, (forwardIn.get(b) ?? 0) + 1);
      }
    }
    const roots = community.atoms.filter(atom => !forwardIn.get(atom.id));
    const anchor = (roots.length ? roots : community.atoms).sort((a, b) => a.order - b.order)[0];
    const singleGroup = community.atoms.length === 1 && groupIds.has(anchor.id);
    return {
      id: `section-${index}`,
      index,
      label: sectionsLabel(singleGroup, automatic, ordered.length, labels.get(anchor.id) ?? 'Diagram'),
      inferred: !singleGroup && ordered.length > 1 && automatic,
      nodeIds: ids.filter(id => nodeIds.has(id)),
      groupIds: ids.filter(id => groupIds.has(id)),
    };
  });
  const sectionByEntity = new Map<string, string>();
  for (const section of sections) for (const id of [...section.nodeIds, ...section.groupIds]) {
    sectionByEntity.set(id, section.id);
  }
  const crossLinks = graph.edges
    .filter(edge => sectionByEntity.get(edge.source) !== sectionByEntity.get(edge.target))
    .filter(edge => edge.stroke !== 'invisible')
    .map((edge, index) => ({
      number: index + 1,
      edge,
      sourceSection: sectionByEntity.get(edge.source)!,
      targetSection: sectionByEntity.get(edge.target)!,
    }));
  return { sections, sectionByEntity, crossLinks };
}

function sectionsLabel(singleGroup: boolean, automatic: boolean, count: number, anchor: string): string {
  if (singleGroup) return anchor;
  if (!automatic) return 'Outside subgraphs';
  if (count === 1) return 'Main flow';
  return anchor.split('\n')[0];
}
