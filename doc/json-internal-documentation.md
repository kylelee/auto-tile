# Documentation for JSON exported layouts

*AutoTile* supports importing and exporting its layouts as a JSON file. With this you can create your own custom layouts, or fine-tune already existing layouts.

The exported layouts (from the preferences) are a collection of `Layout` objects. A `Layout` object is an object with two (2) properties: 

- identifier as a `string` 
- a list of `Tile` objects

Example JSON of a `Layout` object would look like

```json
{
	"id": "The identifier",
	"tiles": [
		...
	]
}
```

A `Tile` object has five (5) properties:

- The X (`x`) axis as a `float`
- The Y (`y`) axis as a `float`
- The width (`width`) as a `float`
- The height (`height`) as a `float`
- A list of identifiers `groups`

The `x`, `y`, `width` and `height` are percentages relative to the screen size. Both `x` and `y` start from the top left of a `Tile`.

So a `Tile` with `x` = 0.5 and `y` = 0.5, on a screen with a resolution of 1920x1080 pixels is placed at `x = 0.5 * 1920 = 960px` and `y = 0.5 * 1080 = 540px`. For example, if the `width` and `height` of the `Tile` are set to `0.25`, this gives a `Tile` of `width = 0.25 * 1920 = 480px` and `height = 0.25 * 1080 = 270px`.

The `groups` attribute is mainly used in the layout editor where it determines which `Tile`(s) are "linked": if you resize a single `Tile` it's linked neighbour(s) are also updated.

For more in depth information you can look at an [in depth explanation](https://github.com/kylelee/AutoTile/issues/177#issuecomment-2458322208) of `group`(s).

Example JSON of a `Tile` object would look like this

```json
{
	"x": 0,
	"y": 0,
	"width": 1,
	"height": 1,
	"groups": [
		1
	]
}
```

## Validation on import

Imported JSON files are validated by `src/components/layout/layoutValidation.ts` before the layouts are used. To be accepted, every layout in the array must satisfy all of the following — layouts that fail are **silently dropped** (the rest of the file is still imported):

- `id` is a `string`;
- `tiles` is a non-empty array;
- every tile has finite numeric `x`, `y`, `width` and `height` (`NaN`/`Infinity`/strings are rejected);
- `groups` is an array of integers.

Geometric range/overlap invariants (e.g. `0 ≤ x`, `x + width ≤ 1`, overlapping tiles) are deliberately *not* checked on import — keep your layouts well-formed by construction.

## Example JSON file

Finally, an example JSON file describing one Layout with two tiles.

```json
{
	"id": "Equal split",
	"tiles": [
		{ 
			"x": 0,
			"y": 0,
			"width": 0.5,
			"height": 1,
			"groups": [
				1
			]
		},
		{
			"x": 0.5,
			"y": 0,
			"width": 0.5,
			"height": 1,
			"groups": [
				1
			]
		}
	]
}
```
