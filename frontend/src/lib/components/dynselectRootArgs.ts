// Context bridge so a `dynselect`/`dynmultiselect` helper nested inside a
// `type:object` group can see the root run-form args, not just its own-level
// siblings. The outermost SchemaForm registers a reactive getter under this
// key; DynamicInput reads it to merge the root args into the helper payload.
export const DYNSELECT_ROOT_ARGS_KEY = Symbol('dynselect-root-args')

export interface DynselectRootArgs {
	readonly args: Record<string, any> | undefined
}
