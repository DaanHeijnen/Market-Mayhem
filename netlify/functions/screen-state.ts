import{getScreenState}from'../lib/queries';import{ok}from'../lib/http';import{wrap,gameIdFrom}from'./_wrap';export default wrap(async r=>ok(await getScreenState(gameIdFrom(r))));
