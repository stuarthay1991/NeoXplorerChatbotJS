/**
 * Drop-in replacement for MUI v4 `makeStyles`: same usage
 * `const classes = useStyles();` then `className={classes.mainpane}`.
 *
 * Styles live in useStyles.module.css (no @material-ui/core).
 */
import styles from './useStyles.module.css';

export default function useStyles() {
  return styles;
}
