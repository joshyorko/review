# Luna Factory repair fixture

The accepted change is to make `subtract(left, right)` return `left - right`.
Keep the standard-library test unchanged and verify with:

```sh
python3 -m unittest discover -s tests
```
