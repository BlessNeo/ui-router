/** @module transition */ /** for typedoc */
import {trace} from "../common/trace";
import {services} from "../common/coreservices";
import {
    map, find, extend, mergeR,  tail,
    omit, toJson, abstractKey, arrayTuples, unnestR, identity, anyTrueR
} from "../common/common";
import { isObject, isArray } from "../common/predicates";
import { prop, propEq, val, not } from "../common/hof";

import {StateDeclaration, StateOrName} from "../state/interface";
import {TransitionOptions, TransitionHookOptions, TreeChanges, IHookRegistry, IHookRegistration, IHookGetter} from "./interface";

import {TransitionHook} from "./transitionHook";
import {HookRegistry, matchState} from "./hookRegistry";
import {HookBuilder} from "./hookBuilder";
import {PathNode} from "../path/node";
import {PathFactory} from "../path/pathFactory";
import {State} from "../state/stateObject";
import {TargetState} from "../state/targetState";
import {Param} from "../params/param";
import {Resolvable} from "../resolve/resolvable";
import {TransitionService} from "./transitionService";
import {ViewConfig} from "../view/interface";
import {Rejection} from "./rejectFactory";
import {ResolveContext} from "../resolve/resolveContext";


let transitionCount = 0;
const stateSelf: (_state: State) => StateDeclaration = prop("self");

/**
 * Represents a transition between two states.
 *
 * When navigating to a state, we are transitioning **from** the current state **to** the new state.
 *
 * This object contains all contextual information about the to/from states, parameters, resolves.
 * It has information about all states being entered and exited as a result of the transition.
 */
export class Transition implements IHookRegistry {
  $id: number;
  success: boolean;

  private _deferred = services.$q.defer();
  /**
   * This promise is resolved or rejected based on the outcome of the Transition.
   *
   * When the transition is successful, the promise is resolved
   * When the transition is unsuccessful, the promise is rejected with the [[TransitionRejection]] or javascript error
   */
  promise: Promise<any> = this._deferred.promise;

  private _options: TransitionOptions;
  private _treeChanges: TreeChanges;

  /**
   * Registers a callback function as an `onBefore` Transition Hook
   *
   * The hook is only registered for this specific `Transition`.
   * For global hooks, use [[TransitionService.onBefore]]
   *
   * See [[IHookRegistry.onBefore]]
   */
  onBefore:   IHookRegistration;
  /**
   * Registers a callback function as an `onStart` Transition Hook
   *
   * The hook is only registered for this specific `Transition`.
   * For global hooks, use [[TransitionService.onStart]]
   *
   * See [[IHookRegistry.onStart]]
   */
  onStart:    IHookRegistration;
  /**
   * Registers a callback function as an `onEnter` State Hook
   *
   * The hook is only registered for this specific `Transition`.
   * For global hooks, use [[TransitionService.onEnter]]
   *
   * See [[IHookRegistry.onEnter]]
   */
  onEnter:    IHookRegistration;
  /**
   * Registers a callback function as an `onRetain` State Hook
   *
   * The hook is only registered for this specific `Transition`.
   * For global hooks, use [[TransitionService.onRetain]]
   *
   * See [[IHookRegistry.onRetain]]
   */
  onRetain:   IHookRegistration;
  /**
   * Registers a callback function as an `onExit` State Hook
   *
   * The hook is only registered for this specific `Transition`.
   * For global hooks, use [[TransitionService.onExit]]
   *
   * See [[IHookRegistry.onExit]]
   */
  onExit:     IHookRegistration;
  /**
   * Registers a callback function as an `onFinish` Transition Hook
   *
   * The hook is only registered for this specific `Transition`.
   * For global hooks, use [[TransitionService.onFinish]]
   *
   * See [[IHookRegistry.onFinish]]
   */
  onFinish:   IHookRegistration;
  /**
   * Registers a callback function as an `onSuccess` Transition Hook
   *
   * The hook is only registered for this specific `Transition`.
   * For global hooks, use [[TransitionService.onSuccess]]
   *
   * See [[IHookRegistry.onSuccess]]
   */
  onSuccess:  IHookRegistration;
  /**
   * Registers a callback function as an `onError` Transition Hook
   *
   * The hook is only registered for this specific `Transition`.
   * For global hooks, use [[TransitionService.onError]]
   *
   * See [[IHookRegistry.onError]]
   */
  onError:    IHookRegistration;
  getHooks:   IHookGetter;

  /**
   * Creates a new Transition object.
   *
   * If the target state is not valid, an error is thrown.
   *
   * @param fromPath The path of [[PathNode]]s from which the transition is leaving.  The last node in the `fromPath`
   *        encapsulates the "from state".
   * @param targetState The target state and parameters being transitioned to (also, the transition options)
   * @param _transitionService The Transition Service instance
   */
  constructor(fromPath: PathNode[], targetState: TargetState, private _transitionService: TransitionService) {
    if (!targetState.valid()) {
      throw new Error(targetState.error());
    }

    // Makes the Transition instance a hook registry (onStart, etc)
    HookRegistry.mixin(new HookRegistry(), this);

    // current() is assumed to come from targetState.options, but provide a naive implementation otherwise.
    this._options = extend({ current: val(this) }, targetState.options());
    this.$id = transitionCount++;
    let toPath = PathFactory.buildToPath(fromPath, targetState);
    this._treeChanges = PathFactory.treeChanges(fromPath, toPath, this._options.reloadState);
    PathFactory.applyViewConfigs(_transitionService.$view, this._treeChanges.to);

    let rootResolvables: Resolvable[] = [
      new Resolvable(Transition, () => this, [], this),
      new Resolvable('$transition$', () => this, [], this),
      new Resolvable('$stateParams', () => this.params(), [], this.params())
    ];

    let rootNode: PathNode = this._treeChanges.to[0];
    let context = new ResolveContext(this._treeChanges.to);
    context.addResolvables(rootResolvables, rootNode.state);
  }

  $from() {
    return tail(this._treeChanges.from).state;
  }

  $to() {
    return tail(this._treeChanges.to).state;
  }

  /**
   * Returns the "from state"
   *
   * @returns The state object for the Transition's "from state".
   */
  from(): StateDeclaration {
    return this.$from().self;
  }

  /**
   * Returns the "to state"
   *
   * @returns The state object for the Transition's target state ("to state").
   */
  to() {
    return this.$to().self;
  }

  /**
   * Determines whether two transitions are equivalent.
   */
  is(compare: (Transition|{to: any, from: any})): boolean {
    if (compare instanceof Transition) {
      // TODO: Also compare parameters
      return this.is({ to: compare.$to().name, from: compare.$from().name });
    }
    return !(
      (compare.to && !matchState(this.$to(), compare.to)) ||
      (compare.from && !matchState(this.$from(), compare.from))
    );
  }

  /**
   * Gets transition parameter values
   *
   * @param pathname Pick which treeChanges path to get parameters for:
   *   (`'to'`, `'from'`, `'entering'`, `'exiting'`, `'retained'`)
   * @returns transition parameter values for the desired path.
   */
  params(pathname: string = "to"): { [key: string]: any } {
    return this._treeChanges[pathname].map(prop("paramValues")).reduce(mergeR, {});
  }

  /**
   * Gets all available resolve tokens (keys)
   *
   * This method can be used in conjunction with [[getResolve]] to inspect the resolve values
   * available to the Transition.
   *
   * The returned tokens include those defined on [[StateDeclaration.resolve]] blocks, for the states
   * in the Transition's [[TreeChanges.to]] path.
   *
   * @returns an array of resolve tokens (keys)
   */
  getResolveTokens(): any[] {
    return new ResolveContext(this._treeChanges.to).getTokens();
  }


  /**
   * Gets resolved values
   *
   * This method can be used in conjunction with [[getResolveTokens]] to inspect what resolve values
   * are available to the Transition.
   *
   * Given a token, returns the resolved data for that token.
   * Given an array of tokens, returns an array of resolved data for those tokens.
   *
   * If a resolvable hasn't yet been fetched, returns `undefined` for that token
   * If a resolvable doesn't exist for the token, throws an error.
   *
   * @param token the token (or array of tokens)
   *
   * @returns an array of resolve tokens (keys)
   */
  getResolveValue(token: (any|any[])): (any|any[]) {
    let resolveContext = new ResolveContext(this._treeChanges.to);
    const getData = token => {
      var resolvable = resolveContext.getResolvable(token);
      if (resolvable === undefined) {
        throw new Error("Dependency Injection token not found: ${stringify(token)}");
      }
      return resolvable.data;
    };

    if (isArray(token)) {
      return token.map(getData);
    }

    return getData(token);
  }

  /**
   * Dynamically adds a new [[Resolvable]] (`resolve`) to this transition.
   *
   * @param resolvable an [[Resolvable]] object
   * @param state the state in the "to path" which should receive the new resolve (otherwise, the root state)
   */
  addResolvable(resolvable: Resolvable, state: StateOrName = ""): void {
    let stateName: string = (typeof state === "string") ? state : state.name;
    let topath = this._treeChanges.to;
    let targetNode = find(topath, node => node.state.name === stateName);
    let resolveContext: ResolveContext = new ResolveContext(topath);
    resolveContext.addResolvables([resolvable], targetNode.state);
  }

  /**
   * Gets the previous transition, from which this transition was redirected.
   *
   * @returns The previous Transition, or null if this Transition is not the result of a redirection
   */
  previous(): Transition {
    return this._options.previous || null;
  }

  /**
   * Get the transition options
   *
   * @returns the options for this Transition.
   */
  options(): TransitionOptions {
    return this._options;
  }

  /**
   * Gets the states being entered.
   *
   * @returns an array of states that will be entered during this transition.
   */
  entering(): StateDeclaration[] {
    return map(this._treeChanges.entering, prop('state')).map(stateSelf);
  }

  /**
   * Gets the states being exited.
   *
   * @returns an array of states that will be exited during this transition.
   */
  exiting(): StateDeclaration[] {
    return map(this._treeChanges.exiting, prop('state')).map(stateSelf).reverse();
  }

  /**
   * Gets the states being retained.
   *
   * @returns an array of states that are already entered from a previous Transition, that will not be
   *    exited during this Transition
   */
  retained(): StateDeclaration[] {
    return map(this._treeChanges.retained, prop('state')).map(stateSelf);
  }

  /**
   * Get the [[ViewConfig]]s associated with this Transition
   *
   * Each state can define one or more views (template/controller), which are encapsulated as `ViewConfig` objects.
   * This method fetches the `ViewConfigs` for a given path in the Transition (e.g., "to" or "entering").
   *
   * @param pathname the name of the path to fetch views for:
   *   (`'to'`, `'from'`, `'entering'`, `'exiting'`, `'retained'`)
   * @param state If provided, only returns the `ViewConfig`s for a single state in the path
   *
   * @returns a list of ViewConfig objects for the given path.
   */
  views(pathname: string = "entering", state?: State): ViewConfig[] {
    let path = this._treeChanges[pathname];
    path = !state ? path : path.filter(propEq('state', state));
    return path.map(prop("views")).filter(identity).reduce(unnestR, []);
  }

  treeChanges = () => this._treeChanges;

  /**
   * Creates a new transition that is a redirection of the current one.
   *
   * This transition can be returned from a [[TransitionService]] hook to
   * redirect a transition to a new state and/or set of parameters.
   *
   * @returns Returns a new [[Transition]] instance.
   */
  redirect(targetState: TargetState): Transition {
    let newOptions = extend({}, this.options(), targetState.options(), { previous: this });
    targetState = new TargetState(targetState.identifier(), targetState.$state(), targetState.params(), newOptions);

    let newTransition = new Transition(this._treeChanges.from, targetState, this._transitionService);
    let originalEnteringNodes = this.treeChanges().entering;
    let redirectEnteringNodes = newTransition.treeChanges().entering;

    // --- Re-use resolve data from original transition ---
    // When redirecting from a parent state to a child state where the parent parameter values haven't changed
    // (because of the redirect), the resolves fetched by the original transition are still valid in the
    // redirected transition.
    //
    // This allows you to define a redirect on a parent state which depends on an async resolve value.
    // You can wait for the resolve, then redirect to a child state based on the result.
    // The redirected transition does not have to re-fetch the resolve.
    // ---------------------------------------------------------

    const nodeIsReloading = (reloadState: State) => (node: PathNode) => {
      return reloadState && node.state.includes[reloadState.name];
    };

    // Find any "entering" nodes in the redirect path that match the original path and aren't being reloaded
    let matchingEnteringNodes: PathNode[] = PathNode.matching(redirectEnteringNodes, originalEnteringNodes)
        .filter(not(nodeIsReloading(targetState.options().reloadState)));

    // Use the existing (possibly pre-resolved) resolvables for the matching entering nodes.
    matchingEnteringNodes.forEach((node, idx) => {
      node.resolvables = originalEnteringNodes[idx].resolvables;
    });

    return newTransition;
  }

  /** @hidden If a transition doesn't exit/enter any states, returns any [[Param]] whose value changed */
  private _changedParams(): Param[] {
    let {to, from} = this._treeChanges;
    if (this._options.reload || tail(to).state !== tail(from).state) return undefined;

    let nodeSchemas: Param[][] = to.map((node: PathNode) => node.paramSchema);
    let [toValues, fromValues] = [to, from].map(path => path.map(x => x.paramValues));
    let tuples = arrayTuples(nodeSchemas, toValues, fromValues);

    return tuples.map(([schema, toVals, fromVals]) => Param.changed(schema, toVals, fromVals)).reduce(unnestR, []);
  }

  /**
   * Returns true if the transition is dynamic.
   *
   * A transition is dynamic if no states are entered nor exited, but at least one dynamic parameter has changed.
   *
   * @returns true if the Transition is dynamic
   */
  dynamic(): boolean {
    let changes = this._changedParams();
    return !changes ? false : changes.map(x => x.dynamic).reduce(anyTrueR, false);
  }

  /**
   * Returns true if the transition is ignored.
   *
   * A transition is ignored if no states are entered nor exited, and no parameter values have changed.
   *
   * @returns true if the Transition is ignored.
   */
  ignored(): boolean {
    let changes = this._changedParams();
    return !changes ? false : changes.length === 0;
  }

  /**
   * @hidden
   */
  hookBuilder(): HookBuilder {
    return new HookBuilder(this._transitionService, this, <TransitionHookOptions> {
      transition: this,
      current: this._options.current
    });
  }

  /**
   * Runs the transition
   *
   * This method is generally called from the [[StateService.transitionTo]]
   *
   * @returns a promise for a successful transition.
   */
  run (): Promise<any> {
    let hookBuilder = this.hookBuilder();
    let runSynchronousHooks = TransitionHook.runSynchronousHooks;
    // TODO: nuke these in favor of chaining off the promise? i.e.,
    // $transitions.onBefore({}, $transition$ => {$transition$.promise.then()}
    const runSuccessHooks = () => runSynchronousHooks(hookBuilder.getOnSuccessHooks(), true);
    const runErrorHooks = ($error$) => runSynchronousHooks(hookBuilder.getOnErrorHooks(), true);
    // Run the success/error hooks *after* the Transition promise is settled.
    this.promise.then(runSuccessHooks, runErrorHooks);

    let syncResult = runSynchronousHooks(hookBuilder.getOnBeforeHooks());

    if (Rejection.isTransitionRejectionPromise(syncResult)) {
      syncResult.catch(() => 0); // issue #2676
      let rejectReason = (<any> syncResult)._transitionRejection;
      this._deferred.reject(rejectReason);
      return this.promise;
    }

    if (!this.valid()) {
      let error = new Error(this.error());
      this._deferred.reject(error);
      return this.promise;
    }

    if (this.ignored()) {
      trace.traceTransitionIgnored(this);
      this._deferred.reject(Rejection.ignored());
      return this.promise;
    }

    // When the chain is complete, then resolve or reject the deferred
    const resolve = () => {
      this.success = true;
      this._deferred.resolve(this);
      trace.traceSuccess(this.$to(), this);
    };

    const reject = (error) => {
      this.success = false;
      this._deferred.reject(error);
      trace.traceError(error, this);
      return services.$q.reject(error);
    };

    trace.traceTransitionStart(this);

    let chain = hookBuilder.asyncHooks().reduce((_chain, step) => _chain.then(step.invokeHook.bind(step)), syncResult);
    chain.then(resolve, reject);

    return this.promise;
  }

  isActive = () => this === this._options.current();

  /**
   * Checks if the Transition is valid
   *
   * @returns true if the Transition is valid
   */
  valid() {
    return !this.error();
  }

  /**
   * The reason the Transition is invalid
   *
   * @returns an error message explaining why the transition is invalid
   */
  error() {
    let state = this.$to();

    if (state.self[abstractKey])
      return `Cannot transition to abstract state '${state.name}'`;
    if (!Param.validates(state.parameters(), this.params()))
      return `Param values not valid for state '${state.name}'`;
  }

  /**
   * A string representation of the Transition
   *
   * @returns A string representation of the Transition
   */
  toString () {
    let fromStateOrName = this.from();
    let toStateOrName = this.to();

    const avoidEmptyHash = (params) =>
      (params["#"] !== null && params["#"] !== undefined) ? params : omit(params, "#");

    // (X) means the to state is invalid.
    let id = this.$id,
        from = isObject(fromStateOrName) ? fromStateOrName.name : fromStateOrName,
        fromParams = toJson(avoidEmptyHash(this._treeChanges.from.map(prop('paramValues')).reduce(mergeR, {}))),
        toValid = this.valid() ? "" : "(X) ",
        to = isObject(toStateOrName) ? toStateOrName.name : toStateOrName,
        toParams = toJson(avoidEmptyHash(this.params()));

    return `Transition#${id}( '${from}'${fromParams} -> ${toValid}'${to}'${toParams} )`;
  }
}