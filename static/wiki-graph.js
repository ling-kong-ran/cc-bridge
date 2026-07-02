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
function initWikiGraph() {
  var canvas = document.getElementById("wiki-graph-canvas");
  if (!canvas) {
    // 若 canvas 还不存在，创建一个并插入到 memory-list-panel
    var container = document.querySelector(".memory-list-panel");
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

  // 尺寸自适应
  resizeWikiGraphCanvas();
  window.addEventListener("resize", resizeWikiGraphCanvas);

  // 鼠标事件
  canvas.addEventListener("mousedown", onWikiGraphMouseDown);
  canvas.addEventListener("mousemove", onWikiGraphMouseMove);
  canvas.addEventListener("mouseup", onWikiGraphMouseUp);
  canvas.addEventListener("mouseleave", onWikiGraphMouseUp);
  canvas.addEventListener("wheel", onWikiGraphWheel, { passive: false });

  // 从 URL 参数读取 cwd
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

  // 计算每个节点的度
  var degreeMap = {};
  edges.forEach(function(e) {
    degreeMap[e.source] = (degreeMap[e.source] || 0) + 1;
    degreeMap[e.target] = (degreeMap[e.target] || 0) + 1;
  });

  // 构建节点列表，计算半径
  var maxDegree = 1;
  nodes.forEach(function(n) {
    n.degree = degreeMap[n.id] || 0;
    if (n.degree > maxDegree) maxDegree = n.degree;
  });

  var w = wikiGraphCanvas._width || wikiGraphCanvas.width;
  var h = wikiGraphCanvas._height || wikiGraphCanvas.height;

  wikiGraphNodes = nodes.map(function(n) {
    var radius = NODE_RADIUS_MIN;
    if (maxDegree > 0 && n.degree > 0) {
      radius = NODE_RADIUS_MIN + (n.degree / maxDegree) * (NODE_RADIUS_MAX - NODE_RADIUS_MIN);
    }
    return {
      id: n.id,
      name: n.name,
      title: n.title || n.name,
      size: n.size || 0,
      degree: n.degree,
      radius: radius,
      x: (Math.random() - 0.5) * w * 0.6,
      y: (Math.random() - 0.5) * h * 0.6,
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
  wikiGraphStable = false;
  wikiGraphHovered = null;
  wikiGraphDragged = null;

  // 偏移使图居中
  wikiGraphOffsetX = w / 2;
  wikiGraphOffsetY = h / 2;
  wikiGraphScale = 1;

  // 启动模拟
  startWikiGraphSimulation();
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

  // 绘制边
  ctx.strokeStyle = "rgba(106, 122, 144, 0.25)";
  ctx.lineWidth = 1;
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
    // 仅当在鼠标按下位置没有发生显著移动时才视为点击打开文件
    if (!wikiGraphDragDidMove) {
      var pos = wikiGraphGetCanvasPos(e);
      var idx = wikiGraphFindNodeAt(pos.x, pos.y);
      if (idx >= 0 && wikiGraphNodes[idx]) {
        var node = wikiGraphNodes[idx];
        if (typeof viewMemoryFile === "function") {
          viewMemoryFile(node.name || node.id);
        }
      }
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
