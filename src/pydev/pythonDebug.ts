/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import {
	Logger, logger,
	DebugSession, LoggingDebugSession,
	InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent,
	Thread, StackFrame, Scope, Source, Handles, Breakpoint
} from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { readFileSync } from 'fs';
import { basename } from 'path';
import { PydevDebugger, Command } from './pydevDebugger';


function logArgsToString(args: any[]): string {
	return args.map(arg => {
		return typeof arg === 'string' ?
			arg :
			JSON.stringify(arg);
	}).join(' ');
}

export function verbose(...args: any[]) {
	logger.verbose(logArgsToString(args));
}

export function log(...args: any[]) {
	logger.log(logArgsToString(args));
}

export function logError(...args: any[]) {
	logger.error(logArgsToString(args));
}

// This interface should always match the schema found in `package.json`.
export interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	program: string;
	stopOnEntry?: boolean;
	args?: string[];
	showLog?: boolean;
	cwd?: string;
	env?: { [key: string]: string; };
	mode?: string;
	remotePath?: string;
	port?: number;
	host?: string;
	buildFlags?: string;
	init?: string;
	trace?: boolean | 'verbose';
	/** Optional path to .env file. */
	envFile?: string;
	backend?: string;
}

interface DebuggerState {
	exited: boolean;
	exitStatus: number;
	breakPoint: DebugBreakpoint;
	breakPointInfo: {};
	breakpointId: number;
	currentThread: DebugThread;
}

interface DebugBreakpoint {
	addr: number;
	continue: boolean;
	file: string;
	functionName?: string;
	id: number;
	line: number;
	stacktrace: number;
	variables?: DebugVariable[];
}

interface DebugThread {
	file: string;
	id: number;
	line: number;
	pc: number;
	function?: DebugFunction;
};

interface DebugLocation {
	pc: number;
	file: string;
	line: number;
	function: DebugFunction;
}

interface DebugFunction {
	name: string;
	value: number;
	type: number;
	goType: number;
	args: DebugVariable[];
	locals: DebugVariable[];
}

interface DebugVariable {
	name: string;
	addr: number;
	type: string;
	realType: string;
	value: string;
	len: number;
	cap: number;
	children: DebugVariable[];
	unreadable: string;
}

class Deferred<T> extends Promise<T> {
	public resolve: (value: T) => void
	public reject: (reason?: any) => void
	constructor() {
		let that = {
			resolve: null,
			reject: null,
		};
		super((resolve, reject) => {
			that.resolve = resolve;
			that.reject = reject;
		});
		this.resolve = that.resolve;
		this.reject = that.reject;
	}
}

class PythonDebugSession extends LoggingDebugSession {

	private _variableHandles: Handles<DebugVariable>;
	private breakpoints: Map<string, DebugBreakpoint[]>;
	private threads: Set<number>;
	private debugState: DebuggerState;
	private pydevd: Deferred<PydevDebugger>;

	private launchArgs: LaunchRequestArguments;

	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
	public constructor() {
		super("mock-debug.txt");

		// this debugger uses zero-based lines and columns
		this.setDebuggerLinesStartAt1(false);
		this.setDebuggerColumnsStartAt1(false);

		this._variableHandles = new Handles<DebugVariable>();
		this.threads = new Set<number>();
		this.debugState = null;
		this.pydevd = null;
		this.breakpoints = new Map<string, DebugBreakpoint[]>();
	}

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
		verbose('InitializeRequest');
		// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		this.sendEvent(new InitializedEvent());

		this.debugState = {
			exited: false,
			exitStatus: null,
			breakPoint: null,
			breakPointInfo: {},
			breakpointId: 0,
			currentThread: null
		};

		this.pydevd = new Deferred();

		response.body = response.body || {};
		response.body.supportsConfigurationDoneRequest = true; // This debug adapter implements the configurationDoneRequest.
		response.body.supportsEvaluateForHovers = true;	// make VS Code to use 'evaluate' when hovering over source
		response.body.supportsStepBack = false; // Pydev does not support 'step back'

		this.sendResponse(response);
		verbose('InitializeResponse');
	}

	/**
	 * MUST create a new pydevd instance.
	 */
	protected launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments): void {
		this.launchArgs = args;

		let port = args.port || 0; // Autoset the port number by default.
		let host = args.host || '127.0.0.1';

		this.pydevd.resolve(new PydevDebugger(port, host, args.program, args));
		this.pydevd.then(pydevd => {
			pydevd.on('call', (command: Command, sequence: number, args) => {
				this.handleEvent(command, sequence, args);
			});
			pydevd.start();
			pydevd.call(Command.CMD_RUN);
		})

		// make sure to 'Stop' the buffered logging if 'trace' is not set
		// logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);

		logger.setup(Logger.LogLevel.Verbose, false);
	}

	private handleEvent(command: Command, sequence: number, args) {
		// Handle aribitrary commands
		switch (command) {
			case Command.CMD_VERSION:
				break
			case Command.CMD_THREAD_CREATE:
				break
		}
	}

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
		verbose('SetBreakPointsRequest');
		if (!this.breakpoints.get(args.source.path)) {
			this.breakpoints.set(args.source.path, []);
		}
		// breakpoint_id, 'python-line', self.get_main_filename(), line, func)
		let file = args.source.path;

		this.pydevd.then(pydevd => {
			this.breakpoints.get(file).map(existingBP => {
				verbose('Clearing: ' + existingBP.id);
				return pydevd.call(Command.CMD_REMOVE_BREAK, ['python-line', args.source.path, existingBP.id]);
			});

			args.lines.map(line => {
				verbose('Creating on: ' + file + ':' + line);

				this.debugState.breakpointId++;
				return pydevd.call(Command.CMD_SET_BREAK, [this.debugState.breakpointId, 'python-line', file, line, 'None']);
			})

			let breakpoints = args.lines.map(line => {
				return { verified: false, line: line };
			})

			response.body = { breakpoints };
			this.sendResponse(response);
			verbose('SetBreakPointsResponse');
		});
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {

		/*
			this.pydevd.call(Command.CMD_LIST_THREADS).then(function ([command, sequence, args]: [Command, number, Array<string>]) {
					TODO: Do something with the result 
			});
		*/

		this.sendResponse(response);
	}

	/**
	 * Returns a fake 'stacktrace' where every 'stackframe' is a word from the current line.
	 */
	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {

		this.sendResponse(response);
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {

		this.sendResponse(response);
	}

	protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {

		this.sendResponse(response);
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {

		this.sendResponse(response);
		// no more lines: run to end
		this.sendEvent(new TerminatedEvent());
	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {

		// this.pydevd.call(Command.CMD_STEP_OVER);

		this.sendResponse(response);
		// no more lines: run to end
		this.sendEvent(new TerminatedEvent());
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse): void {

		// this.pydevd.call(Command.CMD_STEP_INTO);
		this.sendResponse(response);
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse): void {

		// this.pydevd.call(Command.CMD_STEP_RETURN);
		this.sendResponse(response);
	}

	protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {

		this.sendResponse(response);
	}

}

DebugSession.run(PythonDebugSession);
