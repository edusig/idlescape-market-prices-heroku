require("dotenv/config");

const io = require("socket.io-client");
const fetch = require("isomorphic-unfetch");

// Web Configs
const webApi = process.env.WEB_API_URL;

// Sheet.Best Configs
const sbApi = process.env.SHEETBEST_API_URL;
const sbApiKey = process.env.SHEETBEST_API_KEY;
const reqHeaders = {
  "Content-Type": "application/json",
  "X-Api-Key": sbApiKey,
};
const deleteHeaders = { "X-Api-Key": sbApiKey };

// Socket.io initialization
const jwt = process.env.JWT_TOKEN;
const characterID = process.env.CHARACTER_ID;
const socket = io("wss://idlescape.com", {
  query: { token: `Bearer ${jwt}`, characterID },
});

// Constants
// Every 200ms (+/- 100ms)
ITEM_ROUTINE_TIMEOUT = 200;
ITEM_RAND_TIMEOUT = 100;

// Shared values
let itemQueue = [];
let processedQueue = [];
let routineTime;
let routineCount = 0;

// Socket message handlers
socket.on("pong", (data) => socket.emit("latency", data));

socket.on("get the market manifest", (data) => {
  console.log("Updating market,", data.length, "items found.");
  routineTime = new Date();
  routineCount = data.length;
  itemQueue = getItemIds(data);
  itemRoutine();
});

socket.on("get player marketplace items", (data) => {
  const body = processItemData(data);
  if (body != null) {
    processedQueue.push(body);
  }
});

// Utilitary functions
const getItemIds = (newItems) => newItems.slice(0).map((it) => it.itemID);

const chooseRandomItem = (len, count) => {
  console.log(
    "Picking item",
    count - (len - 1),
    "of",
    count,
    `(${(((count - (len - 1)) / count) * 100).toFixed(2)}%)`
  );
  const idx = Math.floor(Math.random() * (len - 1));
  return idx;
};

const getRelativeMin = (data) =>
  Math.floor(
    data.reduce((acc, it) => acc + it.price * it.stackSize, 0) /
      data.reduce((acc, it) => acc + it.stackSize, 0)
  );
const getPercent = (data, percent) => {
  const pct = Math.ceil(data.length * percent);
  return pct >= 1 ? pct : 1;
};

const processItemData = (data) => {
  if (data.length <= 0) {
    return null;
  }
  console.log("Processing:", data[0].name, `(${data[0].itemID})`);
  const middle = Math.floor((data.length - 1) / 2);
  const medianData = data[!isNaN(middle) && middle >= 0 ? middle : 0];
  const median =
    medianData != null && medianData.hasOwnProperty("price")
      ? medianData.price
      : data[0].price;
  // Removes outliers (Price > 1 Billion or 100x greater than the median)
  const filtered = data.filter(
    (it) => it.price <= 1000000000 && it.price <= median * 100
  );
  if (filtered.length <= 0) {
    console.log("Everything was filtered out", JSON.stringify(data));
    return null;
  }
  const sum = filtered.reduce((acc, it) => acc + it.price, 0);
  const mean = sum / filtered.length;
  return {
    id: filtered[0].itemID,
    routineAtTime: routineTime.getTime(),
    data: JSON.stringify({
      name: filtered[0].name,
      minPrice: filtered[0].price,
      maxPrice: filtered[filtered.length - 1].price,
      medianPrice: filtered[Math.floor((filtered.length - 1) / 2)].price,
      sumPrice: sum,
      meanPrice: mean,
      volume: filtered.reduce((acc, it) => acc + it.stackSize, 0),
      offerCount: data.length,
      relativeMinPriceFirst5: getRelativeMin(filtered.slice(0, 5)),
      relativeMinPriceFirst10: getRelativeMin(filtered.slice(0, 10)),
      relativeMinPriceFirst5Pct: getRelativeMin(
        filtered.slice(0, getPercent(filtered, 0.05))
      ),
      relativeMinPriceFirst10Pct: getRelativeMin(
        filtered.slice(0, getPercent(filtered, 0.1))
      ),
      relativeMinPriceFirst15Pct: getRelativeMin(
        filtered.slice(0, getPercent(filtered, 0.15))
      ),
      stdDeviation: Math.sqrt(
        filtered.reduce((acc, it) => acc + Math.pow(it.price - mean, 2), 0) /
          filtered.length
      ),
      routineAt: routineTime.toISOString(),
      updatedAt: new Date().toISOString(),
      updatedAtTime: new Date().getTime(),
    }),
  };
};

const updatesSheetItems = async (queue) => {
  try {
    console.log("ABOUT TO WRITE TO THE SPREADSHEET", new Date());
    await fetch(`${sbApi}/0:400`, {
      headers: deleteHeaders,
      method: "DELETE",
    });
    await fetch(sbApi, {
      headers: reqHeaders,
      body: JSON.stringify(queue),
      method: "POST",
    });
    await fetch(`${sbApi}/tabs/market-history`, {
      headers: reqHeaders,
      body: JSON.stringify(queue),
      method: "POST",
    });
    await fetch(`${webApi}/update-market-prices-cache`, {
      headers: { "Content-type": "application/json" },
      body: JSON.stringify(
        queue.map((it) => ({
          itemID: it.id,
          routineAtTime: it.routineAtTime,
          ...JSON.parse(it.data),
        }))
      ),
      method: "POST",
    });
    console.log("SPREADSHEET UPDATED", new Date());
  } catch (e) {
    console.log("Errored at:", new Date().toISOString());
    console.error(e);
    throw e;
  }
};

// Main routines
const marketRoutine = () => {
  console.log("ITS TIME TO UPDATE", new Date().toISOString());
  processedQueue = [];
  socket.emit("get the market manifest");
};

const itemRoutine = () => {
  let idx = chooseRandomItem(itemQueue.length, routineCount);
  let it = itemQueue.splice(idx, 1)[0];
  socket.emit("get player marketplace items", it);
  console.log(
    "Processed Queue",
    processedQueue.length,
    "\nRoutineCount",
    routineCount,
    "\nItemQueue",
    itemQueue.length
  );
  if (itemQueue.length > 0) {
    setTimeout(
      itemRoutine,
      ITEM_ROUTINE_TIMEOUT +
        Math.floor(Math.random() * ITEM_RAND_TIMEOUT) -
        ITEM_RAND_TIMEOUT / 2
    );
  } else {
    updatesSheetItems(
      processedQueue.sort(
        (a, b) => parseInt(a.id.toString(), 10) - parseInt(b.id.toString(), 10)
      )
    );
  }
};

console.log("STARTING CLIENT");
setTimeout(() => marketRoutine(), 2000);
