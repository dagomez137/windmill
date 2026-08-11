<script lang="ts" module>
	function validSelectObject(x): string | undefined {
		if (typeof x != 'object') {
			return JSON.stringify(x) + ' is not an object'
		}
		let keys = Object.keys(x)
		if (!keys.includes('value') || !keys.includes('label')) {
			return JSON.stringify(x) + ' does not contain value or label field'
		}
		if (typeof x['label'] != 'string') {
			return JSON.stringify(x) + ' label is not a string'
		}
		return
	}
</script>

<script lang="ts">
	import { usePromise } from '$lib/svelte5Utils.svelte'
	import JobLoader, { type Callbacks } from './JobLoader.svelte'
	import Select from './select/Select.svelte'
	import MultiSelect from './select/MultiSelect.svelte'
	import { safeSelectItems } from './select/utils.svelte'
	import Tooltip from './Tooltip.svelte'
	import { Loader2 } from 'lucide-svelte'
	import { type DynamicInput } from '$lib/utils'
	import { deepEqual } from 'fast-equals'
	import { getContext, untrack } from 'svelte'
	import { getHelperEntrypointArgs } from '$lib/infer'
	import { DYNSELECT_ROOT_ARGS_KEY, type DynselectRootArgs } from './dynselectRootArgs'

	interface Props {
		value?: any
		helperScript?: DynamicInput.HelperScript
		format: string
		otherArgs?: Record<string, any>
		name: string
		/** Workspace the helper script runs in; defaults to the nav workspace. */
		workspace?: string
	}

	let {
		value = $bindable(),
		helperScript,
		format,
		otherArgs: otherArgs,
		workspace = undefined
	}: Props = $props()

	// Root run-form args, exposed by the outermost SchemaForm. Lets a dynselect
	// nested inside a type:object group key its options off top-level fields.
	// `undefined` when rendered outside a SchemaForm (e.g. apps) → behaves as before.
	const rootArgsCtx = getContext<DynselectRootArgs | undefined>(DYNSELECT_ROOT_ARGS_KEY)
	let rootArgs = $derived(rootArgsCtx?.args ?? {})
	// Own-level args win on key collision, so existing top-level helpers are
	// unaffected (their otherArgs already carry every sibling).
	let mergedArgs = $derived({ ...rootArgs, ...otherArgs })

	let [inputType, entrypoint] = $derived(format.includes('-') ? format.split('-', 2) : [format, ''])

	let isMultiple = $derived(inputType === 'dynmultiselect')
	let isSelect = $derived(inputType === 'dynselect' || inputType === 'dynmultiselect')

	$effect.pre(() => {
		if (isMultiple && value === undefined) {
			value = []
		}
	})

	let resultJobLoader: JobLoader | undefined = $state()
	// loadInit:false — the $effect below owns the first refresh once
	// resultJobLoader is bound; without this the promise is kicked off twice.
	let _items = usePromise(getItemsFromOptions, { clearValueOnRefresh: false, loadInit: false })
	let items = $derived(_items.value)

	let filterText: string = $state('')
	let open: boolean = $state(false)

	// Hard deadline on the helper job. A dynselect answers in a few seconds when
	// a worker is free; a job sitting in a starved queue would otherwise keep the
	// promise pending and the field on "Loading..." forever. On expiry the job is
	// cancelled and the error line shows; reopening the dropdown retries.
	const JOB_TIMEOUT_MS = 30_000

	async function getItemsFromOptions() {
		return new Promise<{ label: string; value: any }[]>((resolve, reject) => {
			let timedOut = false
			const watchdog = setTimeout(() => {
				timedOut = true
				reject(
					`No result after ${JOB_TIMEOUT_MS / 1000}s (worker busy or helper stalled), ` +
						'job cancelled. Reopen the dropdown to retry.'
				)
				resultJobLoader?.cancelJob()
			}, JOB_TIMEOUT_MS)
			let cb: Callbacks = {
				doneResult({ result }) {
					clearTimeout(watchdog)
					if (!result || !Array.isArray(result)) {
						if (result?.error?.message && result?.error?.name) {
							reject(
								`Error in ${inputType} function execution: ` +
									result?.error?.name +
									' - ' +
									result?.error?.message
							)
						} else {
							reject('Result was not an array but ' + JSON.stringify(result, null, 2))
						}
						return
					}
					if (result.length == 0) resolve([])

					if (result.every((x) => typeof x == 'string')) {
						result = result.map((x) => ({ label: x, value: x }))
					} else if (result.find((x) => validSelectObject(x) != undefined)) {
						reject(validSelectObject(result.find((x) => validSelectObject(x) != undefined)))
						return
					}
					resolve(result)
				},
				cancel: () => {
					clearTimeout(watchdog)
					if (!timedOut) reject()
				},
				doneError({ id, error }) {
					clearTimeout(watchdog)
					reject(error)
				}
			}
			resultJobLoader?.runDynamicInputScript(
				entrypoint,
				helperScript!,
				// _rootArgs is the namespaced escape hatch for ancestor fields that
				// collide with a local arg name; absorbed by the helper's **kwargs.
				{ ...mergedArgs, filterText, _ENTRYPOINT_OVERRIDE: entrypoint, _rootArgs: rootArgs },
				cb
			)
		})
	}

	let neverLoaded = $state(true)

	$effect(() => {
		if (_items.value && value !== undefined && isSelect) {
			// A filtered fetch returns a subset, not the universe of valid values:
			// pruning against it drops a legitimate selection, and with a schema
			// default the prune/re-default cycle between this effect and ArgInput's
			// computeDefaultValue never converges (each round re-renders the form
			// and, with the dropdown open, submits another helper job). Prune only
			// against a complete, settled list.
			if (filterText || nfilterText || _items.status === 'loading') return
			if (isMultiple && Array.isArray(value) && Array.isArray(_items.value)) {
				const availableValues = new Set(_items.value.map((x) => x.value))
				const filteredValue = value.filter((v) => availableValues.has(v))
				if (filteredValue.length !== value.length) {
					value = filteredValue
				}
			} else if (!isMultiple && value !== undefined && value !== '') {
				// '' is the empty default, not a stale selection — leave it.
				if (!_items.value.find((x) => x.value == value)) {
					value = undefined
				}
			}
		}
	})

	let lastArgs = $state.snapshot(untrack(() => otherArgs))

	let timeout: number | undefined = $state()
	let nargs = $state($state.snapshot(untrack(() => otherArgs)))
	$effect(() => {
		otherArgs
		untrack(() => clearTimeout(timeout))
		timeout = setTimeout(() => {
			nargs = $state.snapshot(otherArgs)
		}, 1000)
	})

	// Debounced mirror of filterText: each keystroke used to submit (and cancel)
	// a fresh helper job; the trigger effect keys on this mirror instead, so one
	// job per typing burst. The dropdown still narrows instantly client-side
	// (SelectDropdown filters the loaded items), and the job submission reads
	// the live filterText, so the eventual result is never staler than the input.
	let filterTimeout: number | undefined = $state()
	let nfilterText = $state('')
	$effect(() => {
		filterText
		untrack(() => clearTimeout(filterTimeout))
		filterTimeout = setTimeout(() => {
			nfilterText = filterText
		}, 250)
	})

	// Parameter names declared by the helper function. When known, we restrict
	// the change-detection to only those keys so typing in unrelated form fields
	// no longer retriggers the dynselect job. `undefined` means we couldn't
	// determine the signature → fall back to a full-args comparison.
	let helperParams = $state<Set<string> | undefined>(undefined)

	$effect(() => {
		const script = helperScript
		const ep = entrypoint
		if (!script) {
			helperParams = undefined
			return
		}
		let cancelled = false
		void getHelperEntrypointArgs(script, ep || undefined).then((params) => {
			if (!cancelled) helperParams = params
		})
		return () => {
			cancelled = true
		}
	})

	function filterArgs(args: Record<string, any> | undefined) {
		if (!args || !helperParams) return args
		const filtered: Record<string, any> = {}
		for (const k of helperParams) {
			if (k in args) filtered[k] = args[k]
		}
		return filtered
	}

	// Refresh on the open edge (closed -> open), on a debounced filter change,
	// and on a genuine change of the args the helper reads. `open` as a plain
	// state gate would refresh on every dependency invalidation while the
	// dropdown is open: any re-render hands down a fresh otherArgs identity, so
	// a value ping-pong elsewhere in the form submits one helper job per Svelte
	// flush until the flush guard kills the form.
	let prevOpen = false
	let lastFilter = ''
	$effect(() => {
		;[nfilterText, entrypoint, helperScript]
		const justOpened = open && !prevOpen
		prevOpen = open
		if (
			resultJobLoader &&
			entrypoint &&
			(justOpened ||
				neverLoaded ||
				nfilterText !== lastFilter ||
				!deepEqual(filterArgs(lastArgs), filterArgs(nargs)))
		) {
			neverLoaded = false
			lastFilter = nfilterText
			lastArgs = $state.snapshot(otherArgs)
			_items.refresh()
		}
	})
</script>

{#if helperScript}
	<JobLoader onlyResult workspaceOverride={workspace} bind:this={resultJobLoader} />

	<div class="w-full flex-col flex">
		{#if inputType === 'dynmultiselect'}
			<MultiSelect
				bind:value
				items={safeSelectItems(items || [])}
				placeholder="Select items"
				noItemsMsg={_items.status === 'loading' ? 'Loading...' : 'No items found'}
				disabled={_items.status === 'loading' && !items?.length}
			/>
		{:else if inputType === 'dynselect'}
			<!-- Present as loading only while there is nothing to show yet: a refresh
			     over an already-loaded list must not disable the field (Select disables
			     itself on loading with no value), the stale list stays selectable. -->
			<Select
				bind:value
				bind:open
				{items}
				bind:filterText
				loading={!open && _items.status === 'loading' && !items?.length}
				clearable
				noItemsMsg={_items.status === 'loading' ? 'Loading...' : 'No items found'}
			/>
		{:else}
			<!-- Future dynamic input types can be added here -->
			<div class="text-red-400 text-sm">
				Unsupported dynamic input type: {inputType}
			</div>
		{/if}
		{#if _items.error}
			<div class="text-red-400 text-2xs">
				error: <Tooltip>{_items.error}</Tooltip>
			</div>
		{/if}
	</div>
{:else}
	<div class="flex flex-col gap-1 w-full">
		<div class="text-xs text-primary"
			>Dynamic input ({inputType}) is not available in this mode, write value directly</div
		>
		{#await import('$lib/components/JsonEditor.svelte')}
			<Loader2 class="animate-spin" />
		{:then Module}
			<Module.default code={JSON.stringify(value, null, 2)} bind:value />
		{/await}
	</div>
{/if}
