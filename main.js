// Interactive semantic map viewer.
// Same architecture as the citation-graph viewer, but node x/y come from a 2D
// UMAP of SPECTER2 embeddings, and there are TWO coexisting groupings:
//   - topics      (BERTopic)        -> topics.json      (default color)
//   - communities (Leiden "cluster")-> communities.json
// Each grouping has its own legend + mute set; the two mutes stack. A global
// toggle overlays the citation edges on the semantic layout.

import Graph from "https://cdn.jsdelivr.net/npm/graphology@0.25.4/+esm";
import { Sigma } from "https://cdn.jsdelivr.net/npm/sigma@2.4.0/+esm";

// ── State ─────────────────────────────────────────────────────────────────
const state = {
  models: [], // [{ key, label }, ...] from data/models.json
  embeddingKey: null, // currently active embedding model key
  switchingModel: false,

  nodesData: null, // { year_min, year_max, nodes: [...] }
  topicsData: null, // { "0": {...}, ... }   BERTopic
  communitiesData: null, // { "0": {...}, ... }   Leiden
  outCSR: null,
  inCSR: null,
  abstracts: null,
  abstractsPromise: null,

  graph: null,
  renderer: null,

  selectedNode: null,
  neighborSet: new Set(),
  hoveredNode: null,

  yearMin: 0,
  yearMax: 9999,

  mutedClusters: new Set(), // muted Leiden communities
  mutedTopics: new Set(), // muted BERTopic topics
  colorBy: "topic", // topic | cluster | year | indegree
  showEdges: false,
  _citeLayerBuilt: false,
  shiftDown: false,

  // Intra-topic citation islands: for each named topic, the connected
  // components of the citation subgraph induced on just that topic's papers.
  // Reveals papers that share a topic but form disconnected citation bodies.
  showIntraTopic: false,
  _intraLayerBuilt: false,
  topicComponents: null, // { compRank, compSizeOf, compSizes } — see computeTopicComponents

  // floating-label bookkeeping for the currently-active grouping
  labelMode: "dynamic", // dynamic | always
  activeLabelEls: {},
  activeLabelData: null,
  activeLabelOrder: [], // gids sorted by size desc (for progressive reveal)

  // v1-like filtering additions:
  filteredSet: null,
  filters: { title: "", author: "", abstract: "", journal: "", keywords: "", mesh: "" },
  index: null,

  table: null,
  _refilterTimer: null,
};

// Sentinel id for the "ungrouped" bucket (no topic / no community): papers
// whose group isn't a named entry in topics.json / communities.json.
const NONE_ID = "__none__";

// Descriptor for each grouping so legend/label/detail code is written once.
function grouping(key) {
  return key === "topic"
    ? { key: "topic", nodeField: "topic", colorField: "topic_color", data: state.topicsData, muted: state.mutedTopics, legendId: "topic-legend" }
    : { key: "cluster", nodeField: "cluster", colorField: "cluster_color", data: state.communitiesData, muted: state.mutedClusters, legendId: "legend" };
}

// ── Boot ──────────────────────────────────────────────────────────────────
main().catch((err) => {
  console.error(err);
  const el = document.getElementById("loading");
  if (el) el.textContent = "Failed to load: " + err.message;
});

async function main() {
  // Available embedding models (data-driven). Fall back to specter2 alone if
  // the manifest is missing, so the viewer still works.
  state.models = await fetch("data/models.json")
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .catch(() => [{ key: "specter2", label: "SPECTER2" }]);
  state.embeddingKey = state.models[0].key;
  const key = state.embeddingKey;

  // Citation edges (edges_*.bin) and abstracts.json are model-independent —
  // node ordering is identical across models, so the CSR indices stay valid
  // and these are loaded once and never reloaded on a model switch.
  const [nodesPayload, topicsPayload, communitiesPayload, outBuf, inBuf] = await Promise.all([
    fetch(`data/${key}/nodes.json`).then((r) => r.json()),
    fetch(`data/${key}/topics.json`).then((r) => r.json()),
    fetch(`data/${key}/communities.json`).then((r) => r.json()),
    fetch("data/edges_out.bin").then((r) => r.arrayBuffer()),
    fetch("data/edges_in.bin").then((r) => r.arrayBuffer()),
  ]);

  state.nodesData = nodesPayload;
  state.topicsData = topicsPayload;
  state.communitiesData = communitiesPayload;
  state.outCSR = parseCSR(outBuf);
  state.inCSR = parseCSR(inBuf);
  state.yearMin = nodesPayload.year_min;
  state.yearMax = nodesPayload.year_max;

  initModelSelect();
  updateSubtitle();
  buildIndex();
  buildGraph();
  initSigma();
  initGroupLabels();
  renderGroupLabels(); // show labels for the default grouping (topic)
  initHover();
  initSelection();
  initShiftTracking();
  initControls();
  initTabs();
  initGlobalFilters();

  updateSelectedCount();
  initYearControls();

  document.getElementById("loading")?.classList.add("hidden");
}

// ── Embedding-model switching ───────────────────────────────────────────────
// Everything that depends on the embeddings — UMAP coordinates, topics, and the
// community centroids — is reloaded per model. Citation edges, abstracts, and
// the graphml-derived fields (title/authors/year/...) are identical across
// models, so the graph, sigma renderer, search index, and current selection are
// reused; only node positions/colors and the grouping payloads are swapped.
function initModelSelect() {
  const sel = document.getElementById("model-select");
  if (!sel) return;
  sel.innerHTML = state.models
    .map((m) => `<option value="${m.key}">${escapeHtml(m.label)}</option>`)
    .join("");
  sel.value = state.embeddingKey;
  sel.addEventListener("change", (e) => switchModel(e.target.value));
}

function modelLabel(key) {
  const m = state.models.find((m) => m.key === key);
  return m ? m.label : key;
}

function updateSubtitle() {
  const el = document.getElementById("subtitle");
  if (!el) return;
  const n = state.nodesData.nodes.length.toLocaleString();
  el.innerHTML = `${n} papers &middot; UMAP of ${escapeHtml(modelLabel(state.embeddingKey))} embeddings`;
}

async function switchModel(key) {
  if (key === state.embeddingKey || state.switchingModel) return;
  const sel = document.getElementById("model-select");
  state.switchingModel = true;
  if (sel) sel.disabled = true;

  try {
    const [nodesPayload, topicsPayload, communitiesPayload] = await Promise.all([
      fetch(`data/${key}/nodes.json`).then((r) => r.json()),
      fetch(`data/${key}/topics.json`).then((r) => r.json()),
      fetch(`data/${key}/communities.json`).then((r) => r.json()),
    ]);

    state.embeddingKey = key;
    state.nodesData = nodesPayload;
    state.topicsData = topicsPayload;
    state.communitiesData = communitiesPayload;

    // Node index i is the same paper across models, so update graph attributes
    // in place rather than rebuilding the graph (keeps camera + selection).
    const nodes = nodesPayload.nodes;
    for (let i = 0; i < nodes.length; i++) {
      const r = nodes[i];
      const size = nodeRenderSize(r);
      state.graph.mergeNodeAttributes(String(i), {
        x: r.x,
        y: r.y,
        size,
        color: nodeColor(r),
        _data: r,
        _baseSize: size,
      });
    }

    // Topic ids are model-specific, so any muted topics are now stale — reset
    // them. Community ids are stable across models, so those mutes are kept.
    state.mutedTopics.clear();

    // Topics changed, so the intra-topic components and their edge layer are
    // stale. Drop and (if the view is active) recompute against the new topics.
    state.topicComponents = null;
    dropIntraTopicLayer();
    if (state.showIntraTopic) {
      computeTopicComponents();
      buildIntraTopicLayer();
    }

    buildIndex();
    buildLegend("topic");
    buildLegend("cluster");
    renderGroupLabels();
    updateSubtitle();

    if (state.filteredSet) applyGlobalFilters();
    else updateSelectedCount();
    state.renderer.refresh();
  } catch (err) {
    console.error("Model switch failed:", err);
    if (sel) sel.value = state.embeddingKey; // revert dropdown to active model
  } finally {
    state.switchingModel = false;
    if (sel) sel.disabled = false;
  }
}

// ── CSR helpers ───────────────────────────────────────────────────────────
function parseCSR(buf) {
  const headerView = new DataView(buf, 0, 4);
  const n = headerView.getUint32(0, true);
  const offsets = new Uint32Array(buf, 4, n + 1);
  const totalEdges = offsets[n];
  const targets = new Uint32Array(buf, 4 + (n + 1) * 4, totalEdges);
  return { n, offsets, targets };
}
function csrNeighbors(csr, idx) {
  return csr.targets.subarray(csr.offsets[idx], csr.offsets[idx + 1]);
}

// ── Index build (fast filtering) ──────────────────────────────────────────
function buildIndex() {
  const nodes = state.nodesData.nodes;
  const title = new Array(nodes.length);
  const authors = new Array(nodes.length);
  const journal = new Array(nodes.length);
  const doi = new Array(nodes.length);
  const keywords = new Array(nodes.length);
  const mesh = new Array(nodes.length);

  for (let i = 0; i < nodes.length; i++) {
    const r = nodes[i];
    title[i] = (r.title || "").toLowerCase();
    authors[i] = (r.authors || "").toLowerCase();
    journal[i] = (r.journal || "").toLowerCase();
    doi[i] = (r.doi || "").toLowerCase();
    keywords[i] = (r.keywords || "").toLowerCase();
    mesh[i] = (r.mesh || "").toLowerCase();
  }
  state.index = { title, authors, journal, doi, keywords, mesh };
}

// ── Graph build ───────────────────────────────────────────────────────────
function nodeRenderSize(rec) {
  const s = (rec.size || 1) * 0.55;
  return Math.max(0.6, Math.min(8, s));
}

function buildGraph() {
  state.graph = new Graph({ type: "directed", multi: false });
  const nodes = state.nodesData.nodes;
  for (let i = 0; i < nodes.length; i++) {
    const r = nodes[i];
    const size = nodeRenderSize(r);
    state.graph.addNode(String(i), {
      x: r.x,
      y: r.y,
      size,
      color: r.topic_color, // default color = topic
      label: "",
      _data: r,
      _baseSize: size,
    });
  }
}

// ── Sigma setup ───────────────────────────────────────────────────────────
function initSigma() {
  const container = document.getElementById("sigma-container");
  state.renderer = new Sigma(state.graph, container, {
    allowInvalidContainer: true,
    renderEdgeLabels: false,
    enableEdgeEvents: false,
    defaultEdgeColor: "#5a667a",
    labelDensity: 0.02,
    labelGridCellSize: 120,
    labelRenderedSizeThreshold: 14,
    labelColor: { color: "#e6e9ef" },
    labelFont: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    minCameraRatio: 0.03,
    maxCameraRatio: 30,
    nodeReducer,
    edgeReducer,
  });
}

function nodeColor(r) {
  switch (state.colorBy) {
    case "topic":
      return r.topic_color;
    case "cluster":
      return r.cluster_color;
    case "year":
      return r.year != null ? yearColor(r.year) : "#888";
    case "indegree":
      return degreeColor(r.indegree || 0);
    default:
      return r.topic_color;
  }
}

// True if r is muted by either grouping. A named group is muted by its id; an
// ungrouped paper (no entry in the grouping's data) is muted by NONE_ID.
function groupMutes(key, r) {
  const g = grouping(key);
  const id = r[g.nodeField];
  return g.data[String(id)] ? g.muted.has(id) : g.muted.has(NONE_ID);
}
function nodeHiddenByMute(r) {
  return groupMutes("topic", r) || groupMutes("cluster", r);
}

function nodeReducer(node, attrs) {
  const a = Object.assign({}, attrs);
  const r = a._data;

  if (state.filteredSet && !state.filteredSet.has(node)) {
    a.hidden = true;
    return a;
  }
  if (r.year != null && (r.year < state.yearMin || r.year > state.yearMax)) {
    a.hidden = true;
    return a;
  }
  // Two independent, stacking mutes (named groups + the ungrouped bucket).
  if (nodeHiddenByMute(r)) {
    a.hidden = true;
    return a;
  }

  a.color = nodeColor(r);
  if (state.showIntraTopic && state.topicComponents) {
    const i = parseInt(node, 10);
    a.color = intraTopicColor(i, r);
    // Genuine islands (a non-main component with >1 paper) often overlap the
    // main body in semantic space, so enlarge + raise them to make them pop.
    const tc = state.topicComponents;
    if (tc.compRank[i] >= 1 && tc.compSizeOf[i] >= 2) {
      a.size = a._baseSize * 1.9;
      a.zIndex = 3;
    }
  }

  if (state.selectedNode !== null) {
    if (node === state.selectedNode) {
      a.size = a._baseSize * 1.6;
      a.zIndex = 4;
      a.label = r.title;
    } else if (state.neighborSet.has(node)) {
      a.zIndex = 3;
    } else {
      a.color = "#2a3140";
      a.size = a._baseSize * 0.5;
      a.zIndex = 0;
      a.label = "";
    }
  }

  if (state.hoveredNode === node) {
    a.size = a._baseSize * 1.4;
    a.zIndex = 5;
  }
  return a;
}

function edgeReducer(edge, attrs) {
  // Static citation layer is hidden unless the global toggle is on.
  if (edge.startsWith("__cite:")) {
    if (!state.showEdges) return { ...attrs, hidden: true };
  } else if (edge.startsWith("__intra:")) {
    if (!state.showIntraTopic) return { ...attrs, hidden: true };
  }
  return attrs;
}

// ── Color modes ───────────────────────────────────────────────────────────
const YEAR_RAMP = [
  [68, 1, 84],
  [59, 82, 139],
  [33, 145, 140],
  [94, 201, 98],
  [253, 231, 37],
];

function yearColor(year) {
  const t =
    (year - state.nodesData.year_min) /
    Math.max(1, state.nodesData.year_max - state.nodesData.year_min);
  return rampColor(YEAR_RAMP, clamp01(t));
}
function degreeColor(d) {
  const t = Math.log10(d + 1) / Math.log10(1000);
  return rampColor(YEAR_RAMP, clamp01(t));
}
function rampColor(ramp, t) {
  const x = t * (ramp.length - 1);
  const i = Math.floor(x);
  const frac = x - i;
  const a = ramp[i];
  const b = ramp[Math.min(i + 1, ramp.length - 1)];
  const r = Math.round(a[0] + (b[0] - a[0]) * frac);
  const g = Math.round(a[1] + (b[1] - a[1]) * frac);
  const bl = Math.round(a[2] + (b[2] - a[2]) * frac);
  return `rgb(${r},${g},${bl})`;
}
function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

// ── Floating group labels (switch with the active grouping) ────────────────
// Dynamic mode: with so many topics, showing every label clutters the map.
// We show the largest groups when zoomed out and progressively reveal smaller
// ones as you zoom in, plus always reveal the label of the hovered/selected
// node's group. "Always" mode shows them all.
const LABEL_RATIO_ALL = 0.12; // camera ratio at/below which all labels show
const LABEL_RATIO_FEW = 1.2; // ratio at/above which only the base set shows
const LABEL_BASE_COUNT = 5; // labels always shown when fully zoomed out

function initGroupLabels() {
  // Reposition + decide visibility for the active labels, every frame.
  state.renderer.on("afterRender", positionLabels);
}

function positionLabels() {
  if (!state.activeLabelData) return;

  const visible = visibleLabelIds();
  const { width, height } = state.renderer.getDimensions();
  const margin = 40;

  for (const gid of Object.keys(state.activeLabelEls)) {
    const el = state.activeLabelEls[gid];
    if (!visible.has(gid)) {
      el.style.display = "none";
      continue;
    }
    const c = state.activeLabelData[gid];
    const pt = state.renderer.graphToViewport({ x: c.centroid[0], y: c.centroid[1] });
    // Cull labels whose centroid is well outside the viewport.
    if (pt.x < -margin || pt.y < -margin || pt.x > width + margin || pt.y > height + margin) {
      el.style.display = "none";
      continue;
    }
    el.style.display = "";
    el.style.transform = `translate(-50%, -50%) translate(${pt.x}px, ${pt.y}px)`;
  }
}

function visibleLabelIds() {
  const order = state.activeLabelOrder;
  if (state.labelMode === "always") return new Set(order);

  const ratio = state.renderer.getCamera().getState().ratio;
  const f = clamp01((LABEL_RATIO_FEW - ratio) / (LABEL_RATIO_FEW - LABEL_RATIO_ALL));
  const count = Math.round(LABEL_BASE_COUNT + f * (order.length - LABEL_BASE_COUNT));
  const visible = new Set(order.slice(0, Math.max(LABEL_BASE_COUNT, count)));

  // Always reveal the group of the hovered/selected node.
  for (const gid of [activeGroupOf(state.hoveredNode), activeGroupOf(state.selectedNode)]) {
    if (gid != null && state.activeLabelData[gid]) visible.add(gid);
  }
  return visible;
}

function activeGroupOf(nodeId) {
  if (nodeId == null) return null;
  const r = state.nodesData.nodes[parseInt(nodeId, 10)];
  if (!r) return null;
  return String(r[grouping(state.colorBy).nodeField]);
}

function renderGroupLabels() {
  const container = document.getElementById("cluster-labels");
  container.innerHTML = "";
  state.activeLabelEls = {};
  state.activeLabelData = null;
  state.activeLabelOrder = [];

  // Continuous color modes have no group labels.
  if (state.colorBy !== "topic" && state.colorBy !== "cluster") {
    state.renderer.refresh();
    return;
  }

  const g = grouping(state.colorBy);
  state.activeLabelData = g.data;
  state.activeLabelOrder = Object.keys(g.data).sort((a, b) => g.data[b].size - g.data[a].size);
  for (const gid of state.activeLabelOrder) {
    const c = g.data[gid];
    const el = document.createElement("div");
    el.className = "cluster-label";
    el.innerHTML = `<span class="swatch" style="background:${c.color}"></span>${escapeHtml(c.name)}`;
    el.addEventListener("click", (e) => {
      showGroupDetail(g.key, gid);
      e.stopPropagation();
    });
    container.appendChild(el);
    state.activeLabelEls[gid] = el;
  }
  state.renderer.refresh();
}

// ── Hover tooltip ─────────────────────────────────────────────────────────
function initHover() {
  const tt = document.getElementById("tooltip");
  const container = document.getElementById("sigma-container");

  state.renderer.on("enterNode", ({ node }) => {
    state.hoveredNode = node;
    const r = state.graph.getNodeAttribute(node, "_data");
    const auths = (r.authors || "").split("|");
    const shown = auths.slice(0, 3).join(", ");
    const more = auths.length > 3 ? " et al." : "";
    tt.innerHTML =
      `<strong>${escapeHtml(r.title)}</strong>` +
      `<div class="tt-meta">${r.year ?? ""}${r.year ? " &middot; " : ""}${escapeHtml(shown)}${more}</div>`;
    tt.hidden = false;
    state.renderer.refresh();
  });

  state.renderer.on("leaveNode", () => {
    state.hoveredNode = null;
    tt.hidden = true;
    state.renderer.refresh();
  });

  container.addEventListener("mousemove", (e) => {
    if (tt.hidden) return;
    const pad = 14;
    let x = e.clientX + pad;
    let y = e.clientY + pad;
    const r = tt.getBoundingClientRect();
    if (x + r.width > window.innerWidth) x = e.clientX - r.width - pad;
    if (y + r.height > window.innerHeight) y = e.clientY - r.height - pad;
    tt.style.left = x + "px";
    tt.style.top = y + "px";
  });
}

// ── Selection (click → draw incident edges + open detail) ────────────────
function initSelection() {
  state.renderer.on("clickNode", ({ node }) => selectNode(parseInt(node, 10)));
  state.renderer.on("clickStage", () => {
    clearSelection();
    hideDetail();
  });
}

function selectNode(idx) {
  clearSelectionEdges();
  state.selectedNode = String(idx);
  const nset = new Set();
  nset.add(state.selectedNode);

  for (const t of csrNeighbors(state.outCSR, idx)) {
    const tid = String(t);
    nset.add(tid);
    const k = `__sel:${idx}->${t}`;
    if (!state.graph.hasEdge(k))
      state.graph.addDirectedEdgeWithKey(k, String(idx), tid, { color: "rgba(78,161,255,0.55)", size: 0.7 });
  }
  for (const s of csrNeighbors(state.inCSR, idx)) {
    const sid = String(s);
    nset.add(sid);
    const k = `__sel:${s}->${idx}`;
    if (!state.graph.hasEdge(k))
      state.graph.addDirectedEdgeWithKey(k, sid, String(idx), { color: "rgba(255,158,78,0.45)", size: 0.6 });
  }
  state.neighborSet = nset;
  state.renderer.refresh();
  showPaperDetail(idx);
}

function clearSelectionEdges() {
  const toRemove = [];
  state.graph.forEachEdge((edge) => {
    if (edge.startsWith("__sel:")) toRemove.push(edge);
  });
  for (const e of toRemove) state.graph.dropEdge(e);
}

function clearSelection() {
  clearSelectionEdges();
  state.selectedNode = null;
  state.neighborSet = new Set();
  state.renderer.refresh();
}

// ── Citation edge layer (global toggle) ────────────────────────────────────
function buildCitationLayer() {
  if (state._citeLayerBuilt) return;
  const n = state.outCSR.n;
  for (let i = 0; i < n; i++) {
    const outs = csrNeighbors(state.outCSR, i);
    for (const t of outs) {
      const k = `__cite:${i}->${t}`;
      if (!state.graph.hasEdge(k))
        state.graph.addDirectedEdgeWithKey(k, String(i), String(t), {
          color: "rgba(120,130,150,0.16)",
          size: 0.25,
        });
    }
  }
  state._citeLayerBuilt = true;
}

// ── Intra-topic citation islands ────────────────────────────────────────────
// For each *named* topic, find the connected components of the citation
// subgraph induced on that topic's papers (citations treated as undirected,
// only edges with both endpoints in the topic). >1 component means papers that
// share a topic but never cite one another — disconnected citation communities.
// Cheap to do at runtime (O(nodes + edges)); recomputed when the model changes.
const ISLAND_PALETTE = ["#ff5d5d", "#ffb14e", "#fa3e7a", "#9d4edd", "#3ad1ff", "#7cff6b"];

function computeTopicComponents() {
  const nodes = state.nodesData.nodes;
  const n = nodes.length;

  // Members of each named topic (skip the -1/unnamed bucket).
  const members = new Map();
  for (let i = 0; i < n; i++) {
    const t = nodes[i].topic;
    if (!state.topicsData[String(t)]) continue;
    if (!members.has(t)) members.set(t, []);
    members.get(t).push(i);
  }

  const compRank = new Int16Array(n).fill(-1); // rank of node's component (0 = largest)
  const compSizeOf = new Int32Array(n); // size of the node's own component
  const compSizes = new Map(); // topic id -> [component sizes, desc]
  const visited = new Uint8Array(n);

  for (const [t, idxs] of members) {
    const inTopic = new Set(idxs);
    const comps = [];
    for (const start of idxs) {
      if (visited[start]) continue;
      visited[start] = 1;
      const stack = [start];
      const comp = [];
      while (stack.length) {
        const u = stack.pop();
        comp.push(u);
        for (const v of csrNeighbors(state.outCSR, u)) {
          if (inTopic.has(v) && !visited[v]) { visited[v] = 1; stack.push(v); }
        }
        for (const v of csrNeighbors(state.inCSR, u)) {
          if (inTopic.has(v) && !visited[v]) { visited[v] = 1; stack.push(v); }
        }
      }
      comps.push(comp);
    }
    comps.sort((a, b) => b.length - a.length);
    comps.forEach((comp, rank) => {
      for (const i of comp) { compRank[i] = rank; compSizeOf[i] = comp.length; }
    });
    compSizes.set(t, comps.map((c) => c.length));
  }

  state.topicComponents = { compRank, compSizeOf, compSizes };
}

// Color for the intra-topic view: the main citation body keeps the topic color,
// genuine multi-paper islands get vivid palette colors, and isolated singletons
// (papers with no intra-topic citation at all) are de-emphasized.
function intraTopicColor(i, r) {
  const tc = state.topicComponents;
  const rank = tc.compRank[i];
  if (rank < 0) return "#3a4150"; // not in a named topic
  if (rank === 0) return r.topic_color; // largest component = the topic's main body
  if (tc.compSizeOf[i] < 2) return "#5a6170"; // lone disconnected paper
  return ISLAND_PALETTE[(rank - 1) % ISLAND_PALETTE.length];
}

function buildIntraTopicLayer() {
  if (state._intraLayerBuilt) return;
  const nodes = state.nodesData.nodes;
  const n = state.outCSR.n;
  for (let i = 0; i < n; i++) {
    const ti = nodes[i].topic;
    if (!state.topicsData[String(ti)]) continue;
    for (const t of csrNeighbors(state.outCSR, i)) {
      if (nodes[t].topic !== ti) continue; // same named topic only
      const k = `__intra:${i}->${t}`;
      if (!state.graph.hasEdge(k))
        state.graph.addDirectedEdgeWithKey(k, String(i), String(t), {
          color: "rgba(150,160,180,0.30)",
          size: 0.4,
        });
    }
  }
  state._intraLayerBuilt = true;
}

function dropIntraTopicLayer() {
  const toRemove = [];
  state.graph.forEachEdge((edge) => {
    if (edge.startsWith("__intra:")) toRemove.push(edge);
  });
  for (const e of toRemove) state.graph.dropEdge(e);
  state._intraLayerBuilt = false;
}

// ── Detail panel ──────────────────────────────────────────────────────────
function showPaperDetail(idx) {
  const r = state.nodesData.nodes[idx];
  const community = state.communitiesData[String(r.cluster)];
  const topic = state.topicsData[String(r.topic)];
  const auths = (r.authors || "").split("|").join(", ");
  const doiHtml = r.doi
    ? `<a href="https://doi.org/${encodeURIComponent(r.doi)}" target="_blank" rel="noopener">Open DOI</a>`
    : "";
  const topicTag = topic
    ? `<span class="cluster-tag" style="background:${topic.color};color:#0e1116">${escapeHtml(topic.name)}</span>`
    : "";
  const communityTag = community
    ? `<span class="cluster-tag" style="background:${community.color};color:#0e1116">${escapeHtml(community.name)}</span>`
    : "";
  const numOut = state.outCSR.offsets[idx + 1] - state.outCSR.offsets[idx];
  const numIn = state.inCSR.offsets[idx + 1] - state.inCSR.offsets[idx];

  document.getElementById("detail-body").innerHTML = `
    ${topicTag} ${communityTag}
    <h2>${escapeHtml(r.title)}</h2>
    <div class="meta">${escapeHtml(auths)}</div>
    <div class="meta">${r.year ?? ""}${r.journal ? " &middot; " + escapeHtml(r.journal) : ""}</div>
    <div class="meta">${r.indegree || 0} citations &middot; cites ${numOut} &middot; cited by ${numIn}</div>
    <div class="actions">
      ${doiHtml}
      <button id="frame-node">Center on paper</button>
    </div>
    <h3>Abstract</h3>
    <div class="abstract" id="abstract-slot">Loading...</div>
  `;
  document.getElementById("detail").hidden = false;
  document.getElementById("frame-node").addEventListener("click", () => frameNode(idx));

  loadAbstract(r.id).then((abs) => {
    const slot = document.getElementById("abstract-slot");
    if (slot) slot.textContent = abs || "(no abstract on file)";
  });
}

function showGroupDetail(key, gid) {
  const g = grouping(key);
  const c = g.data[gid];
  if (!c) return;
  const label = key === "topic" ? "Topic" : "Community";

  const papers = (c.top_papers || [])
    .map((p) => `<li>${escapeHtml(p.title)}<div class="sub">${p.year ?? ""}${p.in_degree ? " &middot; " + p.in_degree + " citations" : ""}</div></li>`)
    .join("");
  const authors = (c.top_authors || [])
    .map((a) => `<li>${escapeHtml(a.name)}<div class="sub">${a.papers ?? ""} papers</div></li>`)
    .join("");
  const keywords = (c.top_keywords || [])
    .map((k) => `<li>${escapeHtml(k.keyword)}<div class="sub">tf-idf ${k.tfidf?.toFixed(3) ?? ""}</div></li>`)
    .join("");
  const wordsBlock = c.top_words
    ? `<h3>Top words</h3><p class="meta">${escapeHtml(c.top_words)}</p>`
    : "";

  // For topics, report how the topic's citation subgraph fragments. We count
  // an "island" as a component with >=2 papers; lone papers (singletons) cite
  // nothing within the topic and are reported separately, not as fragmentation.
  let compBlock = "";
  if (key === "topic") {
    if (!state.topicComponents) computeTopicComponents();
    const sizes = state.topicComponents.compSizes.get(c.id) || [];
    if (sizes.length) {
      const total = sizes.reduce((a, b) => a + b, 0); // == papers in the topic
      const islands = sizes.filter((s) => s >= 2); // sorted desc already
      const isolated = sizes.filter((s) => s === 1).length;
      const pct = (s) => Math.round((100 * s) / total);
      const isoText = isolated
        ? `, plus ${isolated} isolated paper${isolated > 1 ? "s" : ""} (${pct(isolated)}%) citing nothing within the topic`
        : "";

      const mainPct = pct(islands[0] || 0);
      let verdict, list = "";
      if (islands.length <= 1) {
        verdict = `Well connected — ${islands[0] || 0} of ${total} papers (${mainPct}%) form one citation body${isoText}.`;
      } else {
        verdict =
          `Fragmented — the largest citation body holds ${islands[0]} of ${total} papers (${mainPct}%); ` +
          `${islands.length - 1} other communit${islands.length - 1 > 1 ? "ies" : "y"} of ≥2 papers ` +
          `are disconnected from it${isoText}.`;
        list =
          `<ul class="top-list">` +
          islands
            .map((s, rank) => {
              const col = rank === 0 ? c.color : ISLAND_PALETTE[(rank - 1) % ISLAND_PALETTE.length];
              const name = rank === 0 ? "Main body" : `Island ${rank}`;
              return `<li><span class="swatch" style="background:${col}"></span>${name}<div class="sub">${s} papers (${pct(s)}%)</div></li>`;
            })
            .join("") +
          `</ul>`;
      }
      compBlock = `
        <h3>Citation structure</h3>
        <p class="meta">${verdict}</p>
        ${list}
        <div class="actions">
          <button id="show-islands">Highlight citation islands</button>
        </div>`;
    }
  }

  document.getElementById("detail-body").innerHTML = `
    <span class="cluster-tag" style="background:${c.color};color:#0e1116">${escapeHtml(c.name)}</span>
    <h2>${escapeHtml(c.name)}</h2>
    <div class="meta">${c.size.toLocaleString()} papers in this ${label.toLowerCase()}</div>
    <div class="actions">
      <button id="isolate-group">Isolate this ${label.toLowerCase()}</button>
      <button id="frame-group">Center view</button>
    </div>
    ${compBlock}
    ${wordsBlock}
    ${keywords ? `<h3>Top keywords</h3><ul class="top-list">${keywords}</ul>` : ""}
    ${authors ? `<h3>Top authors</h3><ul class="top-list">${authors}</ul>` : ""}
    ${papers ? `<h3>Top papers</h3><ul class="top-list">${papers}</ul>` : ""}
  `;
  document.getElementById("detail").hidden = false;
  document.getElementById("frame-group").addEventListener("click", () => frameGroup(key, gid));
  document.getElementById("isolate-group").addEventListener("click", () => isolateGroup(key, gid));
  document.getElementById("show-islands")?.addEventListener("click", () => highlightTopicIslands(key, gid));
}

// One-click: isolate this topic and turn on the intra-topic citation view, so
// its disconnected citation communities (if any) stand out immediately.
function highlightTopicIslands(key, gid) {
  if (!state.topicComponents) computeTopicComponents();
  buildIntraTopicLayer();
  state.showIntraTopic = true;
  const cb = document.getElementById("intra-toggle");
  if (cb) cb.checked = true;
  isolateGroup(key, gid); // refreshes legend + renderer + refilter
  frameGroup(key, gid);
}

function hideDetail() {
  document.getElementById("detail").hidden = true;
}

// ── Camera helpers ────────────────────────────────────────────────────────
function frameNode(idx) {
  const display = state.renderer.getNodeDisplayData(String(idx));
  if (!display) return;
  state.renderer.getCamera().animate({ x: display.x, y: display.y, ratio: 0.15 }, { duration: 600 });
}

function frameGroup(key, gid) {
  const g = grouping(key);
  const c = g.data[gid];
  const cx = c.centroid[0],
    cy = c.centroid[1];
  let bestIdx = -1;
  let bestDist = Infinity;
  const nodes = state.nodesData.nodes;
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i][g.nodeField] !== c.id) continue;
    const dx = nodes[i].x - cx,
      dy = nodes[i].y - cy;
    const d = dx * dx + dy * dy;
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  if (bestIdx >= 0) frameNode(bestIdx);
}

// ── Isolate / legends ──────────────────────────────────────────────────────
function isolateGroup(key, gid) {
  const g = grouping(key);
  g.muted.clear();
  // Mute every named group except the target...
  for (const k of Object.keys(g.data)) {
    if (k !== String(gid)) g.muted.add(parseInt(k, 10));
  }
  // ...and the ungrouped bucket too (unless it's the target).
  if (String(gid) !== NONE_ID) g.muted.add(NONE_ID);
  refreshLegend(key);
  state.renderer.refresh();
  scheduleRefilter();
}

// ── Controls ──────────────────────────────────────────────────────────────
function initControls() {
  document.getElementById("color-by").addEventListener("change", (e) => {
    state.colorBy = e.target.value;
    renderGroupLabels();
    state.renderer.refresh();
  });

  document.getElementById("label-mode").addEventListener("change", (e) => {
    state.labelMode = e.target.value;
    state.renderer.refresh();
  });

  document.getElementById("edges-toggle").addEventListener("change", (e) => {
    state.showEdges = e.target.checked;
    if (state.showEdges) buildCitationLayer();
    state.renderer.refresh();
  });

  document.getElementById("intra-toggle").addEventListener("change", (e) => {
    state.showIntraTopic = e.target.checked;
    if (state.showIntraTopic) {
      if (!state.topicComponents) computeTopicComponents();
      buildIntraTopicLayer();
    }
    state.renderer.refresh();
  });

  document.getElementById("detail-close").addEventListener("click", () => {
    hideDetail();
    clearSelection();
  });

  buildLegend("topic");
  buildLegend("cluster");
  initSearch();
  initControlsToggle();
}

function initSearch() {
  const input = document.getElementById("search");
  const list = document.getElementById("search-results");
  if (!input || !list) return;
  let timer = null;

  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => runSearch(input.value), 120);
  });

  function runSearch(q) {
    q = q.trim().toLowerCase();
    if (q.length < 3) {
      list.hidden = true;
      list.innerHTML = "";
      return;
    }
    const hits = [];
    const nodes = state.nodesData.nodes;
    const idx = state.index;
    for (let i = 0; i < nodes.length && hits.length < 25; i++) {
      if (idx.title[i].includes(q) || idx.authors[i].includes(q) || idx.doi[i].includes(q)) hits.push(i);
    }
    list.innerHTML = hits
      .map((i) => {
        const r = nodes[i];
        const firstAuthor = (r.authors || "").split("|")[0] || "";
        return `<li data-idx="${i}">${escapeHtml(r.title)}<div class="meta">${r.year ?? ""} &middot; ${escapeHtml(firstAuthor)}</div></li>`;
      })
      .join("");
    list.hidden = hits.length === 0;
    for (const li of list.children) {
      li.addEventListener("click", () => {
        const i = parseInt(li.dataset.idx, 10);
        selectNode(i);
        frameNode(i);
        list.hidden = true;
        list.innerHTML = "";
        input.value = "";
      });
    }
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      list.hidden = true;
      list.innerHTML = "";
      input.value = "";
    }
  });
  input.addEventListener("blur", () => setTimeout(() => (list.hidden = true), 150));
}

function initYearControls() {
  const ymin = document.getElementById("year-min");
  const ymax = document.getElementById("year-max");
  const readout = document.getElementById("year-readout");

  ymin.min = ymax.min = state.nodesData.year_min;
  ymin.max = ymax.max = state.nodesData.year_max;
  ymin.value = state.nodesData.year_min;
  ymax.value = state.nodesData.year_max;

  function updateYear() {
    let lo = parseInt(ymin.value, 10);
    let hi = parseInt(ymax.value, 10);
    if (lo > hi) [lo, hi] = [hi, lo];
    state.yearMin = lo;
    state.yearMax = hi;
    readout.textContent = `${lo}–${hi}`;
    state.renderer.refresh();
    scheduleRefilter();
  }
  ymin.addEventListener("input", updateYear);
  ymax.addEventListener("input", updateYear);
  updateYear();
}

function buildLegend(key) {
  const g = grouping(key);
  const ul = document.getElementById(g.legendId);
  ul.innerHTML = "";
  // Drop any button row from a previous build so switching models doesn't stack
  // duplicate Select All / Deselect All rows.
  ul.parentNode.querySelector(".legend-btn-row")?.remove();

  const btnRow = document.createElement("div");
  btnRow.className = "legend-btn-row";
  btnRow.innerHTML = `
    <button data-act="all" type="button">Select All</button>
    <button data-act="none" type="button">Deselect All</button>
  `;
  ul.parentNode.insertBefore(btnRow, ul);

  btnRow.querySelector('[data-act="all"]').addEventListener("click", () => {
    g.muted.clear();
    refreshLegend(key);
    state.renderer.refresh();
    scheduleRefilter();
  });
  btnRow.querySelector('[data-act="none"]').addEventListener("click", () => {
    g.muted.clear();
    for (const cid of Object.keys(g.data)) g.muted.add(parseInt(cid, 10));
    g.muted.add(NONE_ID); // also mute the ungrouped bucket
    refreshLegend(key);
    state.renderer.refresh();
    scheduleRefilter();
  });

  function toggleRow(idValue) {
    if (g.muted.has(idValue)) g.muted.delete(idValue);
    else g.muted.add(idValue);
    refreshLegend(key);
    state.renderer.refresh();
    scheduleRefilter();
  }

  const ids = Object.keys(g.data).sort((a, b) => g.data[b].size - g.data[a].size);
  for (const cid of ids) {
    const c = g.data[cid];
    const li = document.createElement("li");
    li.dataset.cid = cid;
    li.innerHTML = `<span class="swatch" style="background:${c.color}"></span>${escapeHtml(c.name)} <span style="margin-left:auto;color:var(--text-dim)">${c.size}</span>`;
    li.style.display = "flex";
    li.addEventListener("click", () => toggleRow(parseInt(cid, 10)));
    li.addEventListener("dblclick", () => {
      g.muted.clear();
      refreshLegend(key);
      state.renderer.refresh();
      scheduleRefilter();
    });
    ul.appendChild(li);
  }

  // Ungrouped bucket: papers whose group isn't a named entry (e.g. topic -1).
  let noneCount = 0;
  for (const node of state.nodesData.nodes) {
    if (!g.data[String(node[g.nodeField])]) noneCount++;
  }
  if (noneCount > 0) {
    const label = key === "topic" ? "No topic" : "No community";
    const li = document.createElement("li");
    li.dataset.cid = NONE_ID;
    li.innerHTML = `<span class="swatch swatch-none"></span><em>${label}</em> <span style="margin-left:auto;color:var(--text-dim)">${noneCount}</span>`;
    li.style.display = "flex";
    li.addEventListener("click", () => toggleRow(NONE_ID));
    ul.appendChild(li);
  }

  refreshLegend(key);
}

function refreshLegend(key) {
  const g = grouping(key);
  const ul = document.getElementById(g.legendId);
  for (const li of ul.children) {
    const cid = li.dataset.cid;
    const idValue = cid === NONE_ID ? NONE_ID : parseInt(cid, 10);
    li.classList.toggle("muted", g.muted.has(idValue));
  }
}

// ── Tabs (Graph/Table) ───────────────────────────────────────────────────
function initTabs() {
  const tabGraph = document.getElementById("tab-graph");
  const viewGraph = document.getElementById("view-graph");
  tabGraph.addEventListener("click", () => {
    tabGraph.classList.add("active");
    viewGraph.classList.add("active");
    state.renderer.refresh();
  });
}

function initControlsToggle() {
  const panel = document.getElementById("controls");
  const btn = document.getElementById("controls-toggle");
  if (!panel || !btn) return;
  btn.addEventListener("click", () => {
    const collapsed = panel.classList.toggle("collapsed");
    btn.textContent = collapsed ? "⟩" : "⟨";
    btn.setAttribute("aria-label", collapsed ? "Show controls" : "Hide controls");
    if (state.renderer) state.renderer.refresh();
  });
}

// ── Global filters (v1-like) ─────────────────────────────────────────────
function initGlobalFilters() {
  const elTitle = document.getElementById("filter-title");
  const elAuthor = document.getElementById("filter-author");
  const elAbstract = document.getElementById("filter-abstract");
  const elJournal = document.getElementById("filter-journal");
  const elKeywords = document.getElementById("filter-keywords");
  const btn = document.getElementById("apply-filters");

  function readFiltersFromUI() {
    state.filters.title = elTitle?.value || "";
    state.filters.author = elAuthor?.value || "";
    state.filters.abstract = elAbstract?.value || "";
    state.filters.journal = elJournal?.value || "";
    state.filters.keywords = elKeywords?.value || "";
  }

  async function run() {
    btn.disabled = true;
    const oldTxt = btn.textContent;
    btn.textContent = "Filtering...";
    try {
      readFiltersFromUI();
      await applyGlobalFilters();
    } finally {
      btn.disabled = false;
      btn.textContent = oldTxt;
    }
  }

  btn.addEventListener("click", run);

  const inputs = [elTitle, elAuthor, elAbstract, elJournal, elKeywords].filter(Boolean);
  for (const input of inputs) {
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      run();
    });
  }
}

function splitCommaQueries(s) {
  return s
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}
function matchesAll(pipeLc, queries) {
  for (const q of queries) if (!pipeLc.includes(q)) return false;
  return true;
}

async function ensureAbstractsLoadedIfNeeded() {
  if (state.filters.abstract.trim() && !state.abstracts) await loadAbstract("n2");
}

async function applyGlobalFilters() {
  await ensureAbstractsLoadedIfNeeded();

  const f = state.filters;
  const qTitle = f.title.trim().toLowerCase();
  const qJournal = f.journal.trim().toLowerCase();
  const qAbstract = f.abstract.trim().toLowerCase();
  const authorQs = splitCommaQueries(f.author);
  const keywordQs = splitCommaQueries(f.keywords);
  const meshQs = splitCommaQueries(f.mesh);

  const lo = state.yearMin;
  const hi = state.yearMax;
  const idx = state.index;
  const nodes = state.nodesData.nodes;
  const out = new Set();

  for (let i = 0; i < nodes.length; i++) {
    const r = nodes[i];
    if (r.year != null && (r.year < lo || r.year > hi)) continue;
    if (nodeHiddenByMute(r)) continue;
    if (qTitle && !idx.title[i].includes(qTitle)) continue;
    if (qJournal && !idx.journal[i].includes(qJournal)) continue;
    if (authorQs.length && !matchesAll(idx.authors[i], authorQs)) continue;
    if (keywordQs.length && !matchesAll(idx.keywords[i], keywordQs)) continue;
    if (meshQs.length && !matchesAll(idx.mesh[i], meshQs)) continue;
    if (qAbstract) {
      const abs = (state.abstracts?.[r.id] || "").toLowerCase();
      if (!abs.includes(qAbstract)) continue;
    }
    out.add(String(i));
  }

  state.filteredSet = out;
  updateSelectedCount();
  state.renderer.refresh();
}

function scheduleRefilter() {
  clearTimeout(state._refilterTimer);
  state._refilterTimer = setTimeout(() => {
    if (state.filteredSet) applyGlobalFilters();
    else updateSelectedCount();
  }, 90);
}

function updateSelectedCount() {
  const el = document.getElementById("selected-count");
  if (!el) return;
  if (!state.filteredSet) {
    let c = 0;
    const nodes = state.nodesData.nodes;
    for (let i = 0; i < nodes.length; i++) {
      const r = nodes[i];
      if (r.year != null && (r.year < state.yearMin || r.year > state.yearMax)) continue;
      if (nodeHiddenByMute(r)) continue;
      c++;
    }
    el.textContent = `Nodes selected: ${c.toLocaleString()}`;
    return;
  }
  el.textContent = `Nodes selected: ${state.filteredSet.size.toLocaleString()}`;
}

// ── Shift key tracking ─────────────────────────────────────────────────────
function initShiftTracking() {
  window.addEventListener("keydown", (e) => {
    if (e.key === "Shift") state.shiftDown = true;
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "Shift") state.shiftDown = false;
  });
}

// ── Lazy-loaded abstracts ────────────────────────────────────────────────
function loadAbstract(nodeId) {
  if (state.abstracts) return Promise.resolve(state.abstracts[nodeId] || "");
  if (!state.abstractsPromise) {
    state.abstractsPromise = fetch("data/abstracts.json")
      .then((r) => r.json())
      .then((obj) => {
        state.abstracts = obj;
        return obj;
      });
  }
  return state.abstractsPromise.then((obj) => obj[nodeId] || "");
}

// ── Utils ─────────────────────────────────────────────────────────────────
function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
