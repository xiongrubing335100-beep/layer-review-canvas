import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';
import {
  PosterTaskControl,
  executePosterTaskControl,
  posterTaskControlView,
} from './poster-task-control.js';

test('queued poster work exposes a visible cancel button', () => {
  const view = posterTaskControlView({
    job_id: 'poster-job-1',
    dispatch: { dispatch_id: 'dispatch-1', status: 'queued' },
  });
  const markup = renderToStaticMarkup(PosterTaskControl({ view, busy: false, onControl() {} }));

  assert.equal(view.action, 'cancel');
  assert.match(markup, />取消待接收任务</);
  assert.doesNotMatch(markup, /放弃任务并释放队列/);
});

test('claimed or delivered but unconfirmed poster work remains locally cancelable', () => {
  for (const status of ['claimed', 'delivered', 'sending_to_codex', 'host_accepted']) {
    assert.equal(posterTaskControlView({
      job_id: 'poster-job-1',
      dispatch: { dispatch_id: 'dispatch-1', status },
    }).action, 'cancel', status);
  }
});

test('active poster work exposes abandon with the exact Codex-turn limitation', () => {
  const view = posterTaskControlView({
    job_id: 'poster-job-1',
    dispatch: { dispatch_id: 'dispatch-1', status: 'processing' },
  });
  const markup = renderToStaticMarkup(PosterTaskControl({ view, busy: false, onControl() {} }));

  assert.equal(view.action, 'abandon');
  assert.match(markup, />放弃任务并释放队列</);
  assert.match(markup, /不能停止当前 active Codex turn/);
});

test('queued control calls cancel with the exact binding then refreshes authoritative state', async () => {
  const calls = [];
  const job = {
    job_id: 'poster-job-1',
    dispatch: { dispatch_id: 'dispatch-1', status: 'awaiting_codex_message' },
  };
  const refreshed = await executePosterTaskControl(job, {
    cancel: async (...args) => { calls.push(['cancel', ...args]); },
    abandon: async (...args) => { calls.push(['abandon', ...args]); },
    refresh: async (...args) => {
      calls.push(['refresh', ...args]);
      return { ...job, dispatch: { ...job.dispatch, status: 'cancelled' } };
    },
  });

  assert.deepEqual(calls, [
    ['cancel', 'poster-job-1', 'dispatch-1'],
    ['refresh', 'poster-job-1', 'dispatch-1'],
  ]);
  assert.equal(refreshed.dispatch.status, 'cancelled');
});

test('active control calls abandon only after confirmation then refreshes and releases the task', async () => {
  const calls = [];
  const job = {
    job_id: 'poster-job-1',
    dispatch: { dispatch_id: 'dispatch-1', status: 'sent_to_codex' },
  };
  const cancelled = await executePosterTaskControl(job, {
    confirmAbandon: () => false,
    cancel: async () => calls.push(['cancel']),
    abandon: async () => calls.push(['abandon']),
    refresh: async () => calls.push(['refresh']),
  });
  assert.equal(cancelled, null);
  assert.deepEqual(calls, []);

  const refreshed = await executePosterTaskControl(job, {
    confirmAbandon: (warning) => {
      calls.push(['confirm', warning]);
      return true;
    },
    cancel: async (...args) => calls.push(['cancel', ...args]),
    abandon: async (...args) => calls.push(['abandon', ...args]),
    refresh: async (...args) => {
      calls.push(['refresh', ...args]);
      return { ...job, dispatch: { ...job.dispatch, status: 'abandoned' } };
    },
  });

  assert.equal(calls[0][0], 'confirm');
  assert.match(calls[0][1], /不能停止当前 active Codex turn/);
  assert.deepEqual(calls.slice(1), [
    ['abandon', 'poster-job-1', 'dispatch-1'],
    ['refresh', 'poster-job-1', 'dispatch-1'],
  ]);
  assert.equal(refreshed.dispatch.status, 'abandoned');
});
