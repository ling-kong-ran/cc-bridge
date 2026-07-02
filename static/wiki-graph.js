/**
 * wiki-graph.js — 知识图谱力导向图渲染器
 * 纯 Canvas 实现，无外部依赖
 * 依赖：全局 viewMemoryFile() (定义于 memory.js)
 */

// ─── 常量 ────────────────────────────────────────────────────
var REPULSION = 8000;        // 库仑斥力常数
var ATTRACTION = 0.005;      // 胡克引力常数
var DAMPING = 0.95;          // 速度阻尼系数
var CENTER_GRAVITY = 0.01;   // 向心力系数
var MAX_ITERATIONS = 300;    // 最大迭代步数
var VELOCITY_THRESHOLD = 0.5; // 停止阈值（平均速度）
var NODE_RADIUS_MIN = 6;     // 最小节点半径
var NODE_RADIUS_MAX = 20;    // 最大节点半径
var LABEL_FONT_SIZE = 12;    // 标签字号
var LABEL_OFFSET = 4;        // 标签与节点间距

// ─── 状态 ────────────────────────────────────────────────────
var wikiGraphNodes = [];       // {id, name, title, size, x, y, vx, vy, radius, degree}
var wikiGraphEdges = [];       // {source, target}
var wikiGraphSimulation = null; // requestAnimationFrame id
var wikiGraphIteration = 0;
var wikiGraphStable = false;
var _lastGraphNodePositions = {}; // 内存缓存：上次模拟收敛后的节点位置 {id: {x, y}}
var _graphSaveTimer = 0;       // debounce timer for localStorage save

// ─── 位置持久化（localStorage）────────────────────────────────
function _graphStorageKey() {
  var cwd = "";
  try { cwd = (typeof cwdInput !== "undefined" && cwdInput) ? cwdInput.value.trim() : ""; } catch(e) {}
  return "ccb_graph_pos_" + (cwd || "default");
}

function saveGraphPositions() {
  if (!wikiGraphNodes || !wikiGraphNodes.length) return;
  var data = {};
  wikiGraphNodes.forEach(function(n) { data[n.id] = { x: n.x, y: n.y }; });
  try { localStorage.setItem(_graphStorageKey(), JSON.stringify(data)); } catch(e) {}
}

function loadGraphPositions() {
  try {
    var raw = localStorage.getItem(_graphStorageKey());
    return raw ? JSON.parse(raw) : {};
  } catch(e) { return {}; }
}

// 交互状态
var wikiGraphHovered = null;      // hover 的节点 index
var wikiGraphDragged = null;      // 拖拽的节点 index
var wikiGraphDragOffsetX = 0;
var wikiGraphDragOffsetY = 0;
var wikiGraphIsPanning = false;
var wikiGraphPanStartX = 0;
var wikiGraphPanStartY = 0;

// 变换
var wikiGraphScale = 1;
var wikiGraphOffsetX = 0;
var wikiGraphOffsetY = 0;
var wikiGraphCanvas = null;
var wikiGraphCtx = null;

// ─── 初始化 ──────────────────────────────────────────────────
var _wikiGraphReady = false;

function initWikiGraph() {
  if (_wikiGraphReady) {
    // 已初始化，只刷新数据，不重复绑定事件
    var cwd = getCurrentCwdForGraph();
    fetchWikiGraphData(cwd);
    return;
  }

  var canvas = document.getElementById("wiki-graph-canvas");
  if (!canvas) {
    var container = document.getElementById("memory-graph-panel");
    if (!container) return;
    canvas = document.createElement("canvas");
    canvas.id = "wiki-graph-canvas";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    canvas.style.cursor = "grab";
    container.appendChild(canvas);
  }
  wikiGraphCanvas = canvas;
  wikiGraphCtx = canvas.getContext("2d");

  resizeWikiGraphCanvas();
  window.addEventListener("resize", resizeWikiGraphCanvas);

  canvas.addEventListener("mousedown", onWikiGraphMouseDown);
  canvas.addEventListener("mousemove", onWikiGraphMouseMove);
  canvas.addEventListener("mouseup", onWikiGraphMouseUp);
  canvas.addEventListener("mouseleave", onWikiGraphMouseUp);
  canvas.addEventListener("wheel", onWikiGraphWheel, { passive: false });

  _wikiGraphReady = true;

  var cwd = getCurrentCwdForGraph();
  fetchWikiGraphData(cwd);
}

function getCurrentCwdForGraph() {
  // 尝试从全局 cwdInput 获取
  if (typeof cwdInput !== "undefined" && cwdInput) {
    return encodeURIComponent(cwdInput.value.trim() || "");
  }
  return "";
}

function resizeWikiGraphCanvas() {
  if (!wikiGraphCanvas) return;
  var rect = wikiGraphCanvas.parentElement.getBoundingClientRect();
  wikiGraphCanvas.width = rect.width * window.devicePixelRatio;
  wikiGraphCanvas.height = rect.height * window.devicePixelRatio;
  wikiGraphCanvas.style.width = rect.width + "px";
  wikiGraphCanvas.style.height = rect.height + "px";
  wikiGraphCtx = wikiGraphCanvas.getContext("2d");
  wikiGraphCtx.scale(window.devicePixelRatio, window.devicePixelRatio);
  wikiGraphCanvas._width = rect.width;
  wikiGraphCanvas._height = rect.height;
  drawWikiGraph();
}

// ─── 数据获取 ────────────────────────────────────────────────
async function fetchWikiGraphData(cwd) {
  var url = "/api/memory/graph";
  if (cwd) url += "?cwd=" + cwd;
  try {
    var resp = await fetch(url);
    var data = await resp.json();
    renderGraph(data);
  } catch (e) {
    console.error("Wiki graph load failed:", e);
  }
}

// ─── 渲染入口 ────────────────────────────────────────────────
function renderGraph(data) {
  if (!data || !data.nodes || !data.edges) return;
  if (!wikiGraphCanvas) return;

  var nodes = data.nodes;
  var edges = data.edges;

  // 停止旧模拟
  stopWikiGraphSimulation();

  // 确保尺寸正确（面板可能刚被显示，需要重新读布局）
  resizeWikiGraphCanvas();

  // 计算每个节点的度
  var degreeMap = {};
  edges.forEach(function(e) {
    degreeMap[e.source] = (degreeMap[e.source] || 0) + 1;
    degreeMap[e.target] = (degreeMap[e.target] || 0) + 1;
  });

  var maxDegree = 1;
  nodes.forEach(function(n) {
    n.degree = degreeMap[n.id] || 0;
    if (n.degree > maxDegree) maxDegree = n.degree;
  });

  var w = wikiGraphCanvas._width || wikiGraphCanvas.width;
  var h = wikiGraphCanvas._height || wikiGraphCanvas.height;

  // 用节点 id 哈希生成确定性初始坐标，避免每次渲染形状不同
  function hashString(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return h;
  }

  // 查缓存位置：localStorage > 内存缓存 > 哈希生成
  var storedPositions = loadGraphPositions();
  // 把 localStorage 数据合并进内存缓存，保证新渲染也能用
  for (var k in storedPositions) {
    if (!_lastGraphNodePositions[k]) {
      _lastGraphNodePositions[k] = storedPositions[k];
    }
  }
  var hasCache = Object.keys(_lastGraphNodePositions).length > 0;

  wikiGraphNodes = nodes.map(function(n) {
    var radius = NODE_RADIUS_MIN;
    if (maxDegree > 0 && n.degree > 0) {
      radius = NODE_RADIUS_MIN + (n.degree / maxDegree) * (NODE_RADIUS_MAX - NODE_RADIUS_MIN);
    }
    var cached = hasCache ? _lastGraphNodePositions[n.id] : null;
    return {
      id: n.id,
      name: n.name,
      title: n.title || n.name,
      size: n.size || 0,
      degree: n.degree,
      radius: radius,
      x: cached ? cached.x : (hashString("x:" + n.id) / 2147483647) * w * 0.45,
      y: cached ? cached.y : (hashString("y:" + n.id) / 2147483647) * h * 0.45,
      vx: 0,
      vy: 0,
      pinned: false,
    };
  });

  // 建立 id -> index 映射
  var idToIndex = {};
  wikiGraphNodes.forEach(function(n, i) { idToIndex[n.id] = i; });

  wikiGraphEdges = edges.map(function(e) {
    return {
      source: idToIndex[e.source],
      target: idToIndex[e.target],
    };
  }).filter(function(e) {
    return e.source !== undefined && e.target !== undefined;
  });

  // 重置状态
  wikiGraphIteration = 0;
  wikiGraphHovered = null;
  wikiGraphDragged = null;
  wikiGraphOffsetX = w / 2;
  wikiGraphOffsetY = h / 2;
  wikiGraphScale = 1;

  // 如果所有节点都有缓存位置且节点集合未变，直接跳过模拟
  var allCached = nodes.length > 0 && wikiGraphNodes.every(function(n) {
    return !!_lastGraphNodePositions[n.id];
  });
  if (allCached && Object.keys(_lastGraphNodePositions).length === nodes.length) {
    wikiGraphStable = true;
  } else {
    wikiGraphStable = false;
    startWikiGraphSimulation();
  }
  drawWikiGraph();
}

// ─── 力模拟 ──────────────────────────────────────────────────
function stepWikiGraphSimulation() {
  if (wikiGraphStable) return;

  var nodes = wikiGraphNodes;
  var edges = wikiGraphEdges;
  var n = nodes.length;
  var i, j;

  // 斥力（Coulomb）：每对节点之间
  for (i = 0; i < n; i++) {
    for (j = i + 1; j < n; j++) {
      var a = nodes[i];
      var b = nodes[j];
      var dx = b.x - a.x;
      var dy = b.y - a.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1) dist = 1;
      var force = REPULSION / (dist * dist);
      var fx = (dx / dist) * force;
      var fy = (dy / dist) * force;
      if (!a.pinned) { a.vx -= fx; a.vy -= fy; }
      if (!b.pinned) { b.vx += fx; b.vy += fy; }
    }
  }

  // 引力（Hooke）：沿边
  edges.forEach(function(e) {
    var a = nodes[e.source];
    var b = nodes[e.target];
    if (!a || !b) return;
    var dx = b.x - a.x;
    var dy = b.y - a.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1) dist = 1;
    var force = ATTRACTION * dist;
    var fx = (dx / dist) * force;
    var fy = (dy / dist) * force;
    if (!a.pinned) { a.vx += fx; a.vy += fy; }
    if (!b.pinned) { b.vx -= fx; b.vy -= fy; }
  });

  // 向心力
  var cx = 0, cy = 0;
  nodes.forEach(function(node) {
    if (!node.pinned) {
      node.vx -= node.x * CENTER_GRAVITY;
      node.vy -= node.y * CENTER_GRAVITY;
    }
  });

  // 应用速度 + 阻尼
  var totalVelocity = 0;
  nodes.forEach(function(node) {
    if (!node.pinned) {
      node.vx *= DAMPING;
      node.vy *= DAMPING;
      node.x += node.vx;
      node.y += node.vy;
      totalVelocity += Math.sqrt(node.vx * node.vx + node.vy * node.vy);
    }
  });

  wikiGraphIteration++;

  // 判断是否稳定
  var avgVelocity = totalVelocity / n;
  if (avgVelocity < VELOCITY_THRESHOLD || wikiGraphIteration >= MAX_ITERATIONS) {
    wikiGraphStable = true;
    // 缓存最终位置到内存和 localStorage
    _lastGraphNodePositions = {};
    nodes.forEach(function(node) {
      _lastGraphNodePositions[node.id] = { x: node.x, y: node.y };
    });
    saveGraphPositions();
  }

  drawWikiGraph();
}

function startWikiGraphSimulation() {
  stopWikiGraphSimulation();
  wikiGraphStable = false;
  wikiGraphIteration = 0;
  simulateWikiGraphTick();
}

function simulateWikiGraphTick() {
  stepWikiGraphSimulation();
  if (!wikiGraphStable) {
    wikiGraphSimulation = requestAnimationFrame(simulateWikiGraphTick);
  } else {
    wikiGraphSimulation = null;
    drawWikiGraph(); // 最终绘制
  }
}

function stopWikiGraphSimulation() {
  if (wikiGraphSimulation) {
    cancelAnimationFrame(wikiGraphSimulation);
    wikiGraphSimulation = null;
  }
}

// ─── 绘制 ────────────────────────────────────────────────────
function drawWikiGraph() {
  var canvas = wikiGraphCanvas;
  var ctx = wikiGraphCtx;
  if (!canvas || !ctx) return;

  var w = canvas._width || canvas.width;
  var h = canvas._height || canvas.height;

  ctx.clearRect(0, 0, w, h);

  var nodes = wikiGraphNodes;
  var edges = wikiGraphEdges;

  if (!nodes || !nodes.length) {
    ctx.fillStyle = "#6a7a90";
    ctx.font = "14px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("No connections in current workspace", w / 2, h / 2);
    return;
  }

  ctx.save();
  ctx.translate(wikiGraphOffsetX, wikiGraphOffsetY);
  ctx.scale(wikiGraphScale, wikiGraphScale);

  // 绘制边：提高对比度，避免图谱线条在深色背景下看不清
  ctx.strokeStyle = "rgba(125, 238, 178, 0.48)";
  ctx.lineWidth = 1.6;
  edges.forEach(function(e) {
    var a = nodes[e.source];
    var b = nodes[e.target];
    if (!a || !b) return;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  });

  // 绘制节点
  nodes.forEach(function(node, i) {
    var isHovered = (wikiGraphHovered === i);
    var isDragged = (wikiGraphDragged === i);

    // 根据度选择颜色：度高的更亮/饱和
    var degreeRatio = node.degree > 0 ? Math.min(node.degree / 5, 1) : 0;
    var r = Math.round(61 + degreeRatio * (200 - 61));
    var g = Math.round(220 + degreeRatio * (255 - 220));
    var b = Math.round(132 + degreeRatio * (200 - 132));

    // 节点圆形
    ctx.beginPath();
    ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
    if (isHovered || isDragged) {
      ctx.fillStyle = "rgba(61, 220, 132, 0.3)";
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius + 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
    }
    ctx.fillStyle = "rgb(" + r + "," + g + "," + b + ")";
    ctx.fill();

    // 边框
    ctx.strokeStyle = isHovered ? "#3ddc84" : "rgba(255,255,255,0.15)";
    ctx.lineWidth = isHovered ? 2 : 1;
    ctx.stroke();

    // 标签
    var label = node.title || node.name || "";
    if (label) {
      // 截断长标签
      if (label.length > 20) label = label.substring(0, 18) + "…";
      ctx.font = LABEL_FONT_SIZE + "px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillStyle = isHovered ? "#e4eaf2" : "#8a9bb0";
      ctx.fillText(label, node.x, node.y + node.radius + LABEL_OFFSET);
    }
  });

  ctx.restore();
}

// ─── 坐标转换 ────────────────────────────────────────────────
function wikiGraphScreenToWorld(sx, sy) {
  return {
    x: (sx - wikiGraphOffsetX) / wikiGraphScale,
    y: (sy - wikiGraphOffsetY) / wikiGraphScale,
  };
}

function wikiGraphGetCanvasPos(e) {
  var rect = wikiGraphCanvas.getBoundingClientRect();
  return {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
  };
}

function wikiGraphFindNodeAt(sx, sy) {
  var world = wikiGraphScreenToWorld(sx, sy);
  var nodes = wikiGraphNodes;
  // 逆序遍历，让上层节点优先（后绘制的在上）
  for (var i = nodes.length - 1; i >= 0; i--) {
    var n = nodes[i];
    var dx = world.x - n.x;
    var dy = world.y - n.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= n.radius + 4) return i;
  }
  return -1;
}

// ─── 交互事件 ────────────────────────────────────────────────
function onWikiGraphMouseDown(e) {
  var pos = wikiGraphGetCanvasPos(e);
  var idx = wikiGraphFindNodeAt(pos.x, pos.y);

  wikiGraphDragStartPos = { x: pos.x, y: pos.y };
  wikiGraphDragDidMove = false;

  if (idx >= 0) {
    // 拖拽节点
    wikiGraphDragged = idx;
    var world = wikiGraphScreenToWorld(pos.x, pos.y);
    wikiGraphDragOffsetX = world.x - wikiGraphNodes[idx].x;
    wikiGraphDragOffsetY = world.y - wikiGraphNodes[idx].y;
    wikiGraphNodes[idx].pinned = true;
    if (wikiGraphNodes[idx].vx) wikiGraphNodes[idx].vx = 0;
    if (wikiGraphNodes[idx].vy) wikiGraphNodes[idx].vy = 0;
    wikiGraphCanvas.style.cursor = "grabbing";
    // 记录鼠标按下时的节点索引，mouseup 时判断是否发生了移动
    wikiGraphDragStartNode = idx;
    e.preventDefault();
    return;
  }

  // 背景拖拽（平移）
  wikiGraphIsPanning = true;
  wikiGraphPanStartX = pos.x;
  wikiGraphPanStartY = pos.y;
  wikiGraphCanvas.style.cursor = "grabbing";
  e.preventDefault();
}

function onWikiGraphMouseMove(e) {
  var pos = wikiGraphGetCanvasPos(e);

  if (wikiGraphDragged !== null) {
    wikiGraphDragDidMove = true;
    var world = wikiGraphScreenToWorld(pos.x, pos.y);
    var node = wikiGraphNodes[wikiGraphDragged];
    node.x = world.x - wikiGraphDragOffsetX;
    node.y = world.y - wikiGraphDragOffsetY;
    // 继续模拟一小段时间实现弹性效果
    if (wikiGraphStable) {
      wikiGraphStable = false;
      wikiGraphIteration = 0;
      simulateWikiGraphTick();
    } else {
      drawWikiGraph();
    }
    e.preventDefault();
    return;
  }

  if (wikiGraphIsPanning) {
    var dx = pos.x - wikiGraphPanStartX;
    var dy = pos.y - wikiGraphPanStartY;
    wikiGraphOffsetX += dx;
    wikiGraphOffsetY += dy;
    wikiGraphPanStartX = pos.x;
    wikiGraphPanStartY = pos.y;
    drawWikiGraph();
    e.preventDefault();
    return;
  }

  // hover 检测
  var idx = wikiGraphFindNodeAt(pos.x, pos.y);
  if (idx !== wikiGraphHovered) {
    wikiGraphHovered = idx;
    wikiGraphCanvas.style.cursor = idx >= 0 ? "pointer" : "grab";
    drawWikiGraph();
  }
}

function onWikiGraphMouseUp(e) {
  if (wikiGraphDragged !== null) {
    wikiGraphDragged = null;
    wikiGraphCanvas.style.cursor = "grab";
    if (!wikiGraphDragDidMove) {
      var pos = wikiGraphGetCanvasPos(e);
      var idx = wikiGraphFindNodeAt(pos.x, pos.y);
      if (idx >= 0 && wikiGraphNodes[idx]) {
        var node = wikiGraphNodes[idx];
        if (typeof viewMemoryFile === "function") {
          viewMemoryFile(node.name || node.id);
        }
      }
    } else {
      // 拖拽结束，保存新位置
      saveGraphPositions();
    }
    e.preventDefault();
    return;
  }

  if (wikiGraphIsPanning) {
    wikiGraphIsPanning = false;
    wikiGraphCanvas.style.cursor = "grab";
    e.preventDefault();
    return;
  }
}

function onWikiGraphWheel(e) {
  e.preventDefault();
  var delta = e.deltaY > 0 ? 0.9 : 1.1;
  var newScale = wikiGraphScale * delta;
  // 缩放限制
  if (newScale < 0.1 || newScale > 5) return;
  wikiGraphScale = newScale;

  // 以鼠标位置为中心缩放
  var pos = wikiGraphGetCanvasPos(e);
  var worldBefore = wikiGraphScreenToWorld(pos.x, pos.y);
  wikiGraphScale = newScale;
  var worldAfter = wikiGraphScreenToWorld(pos.x, pos.y);
  wikiGraphOffsetX += (worldAfter.x - worldBefore.x) * wikiGraphScale;
  wikiGraphOffsetY += (worldAfter.y - worldBefore.y) * wikiGraphScale;

  drawWikiGraph();
}

// ─── 刷新接口（供外部调用）────────────────────────────────
function refreshWikiGraph() {
  var cwd = getCurrentCwdForGraph();
  fetchWikiGraphData(cwd);
}
