#!/usr/bin/env node
'use strict';
// Drop-in entry point. Keep package.json's existing memex-ui bin unchanged.
const {start}=require('./lib/server.cjs');
if(require.main===module)start().catch(error=>{console.error('[memex-ui]',error.message);process.exitCode=1;});
module.exports=require('./lib/server.cjs');
